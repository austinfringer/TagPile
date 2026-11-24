//Library-scoped routes for search, files and file tagging. Mounted under
///api/libraries/:libraryId behind libraryScope, so every handler has a scoped library.

import { Router, type Response } from 'express';
import type { Db } from '../db/index.ts';
import {
  filesInLibrary,
  getFileSummaries,
  getLocationsInLibrary,
  type FileSummary,
  type LocationRecord,
} from '../db/file_operations.ts';
import { autocomplete, search } from '../db/search_operations.ts';
import * as tagOps from '../db/tagging_operations.ts';
import type { AnchorInput, FileInstance, FileValue } from '../db/tagging_operations.ts';
import { requireCapability, scopeOf } from './libraryScope.ts';
import { isPositiveInt, parseId, parseQueryInt, parseQueryString, sendError } from './util.ts';

export const MAX_PAGE = 500;
export const MAX_BATCH_FILES = 500;
export const MAX_BATCH_OPS = 50;
export const MAX_AUTOCOMPLETE = 50;

/** The body of a new file value. The shape is checked here; the DB layer checks the content
 *  (for example the anchor ranges) and throws ValidationError. */
export type FileValueInput =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'tag'; refTagId: number }
  | { kind: 'anchor'; anchor: AnchorInput };

export type BatchOp =
  | { op: 'tag'; tagId: number }
  | { op: 'untag'; tagId: number }
  | { op: 'addValue'; tagId: number; value: FileValueInput }
  | { op: 'clearValues'; tagId: number };

const ANCHOR_FIELDS = ['tStart', 'tEnd', 'rx', 'ry', 'rw', 'rh'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks the shape of a file value body. Returns the value, or an error message. */
export function parseFileValue(body: unknown): FileValueInput | string {
  if (!isObject(body)) return 'value must be an object';
  switch (body.kind) {
    case 'text':
      return typeof body.text === 'string' && body.text !== ''
        ? { kind: 'text', text: body.text }
        : 'text must be a non-empty string';
    case 'number':
      return typeof body.number === 'number' && Number.isFinite(body.number)
        ? { kind: 'number', number: body.number }
        : 'number must be a finite number';
    case 'tag':
      return isPositiveInt(body.refTagId)
        ? { kind: 'tag', refTagId: body.refTagId }
        : 'refTagId must be a positive integer';
    case 'anchor': {
      const anchor = body.anchor;
      if (!isObject(anchor)) return 'anchor must be an object';
      const out: AnchorInput = {};
      for (const field of ANCHOR_FIELDS) {
        const v = anchor[field];
        if (v !== undefined && v !== null && typeof v !== 'number') {
          return `anchor.${field} must be a number or null`;
        }
        out[field] = v ?? null;
      }
      return { kind: 'anchor', anchor: out };
    }
    default:
      return "kind must be one of 'text', 'number', 'tag', 'anchor'";
  }
}

/** Checks the shape of one batch op. Returns the op, or an error message. */
function parseBatchOp(raw: unknown): BatchOp | string {
  if (!isObject(raw)) return 'op must be an object';
  if (!isPositiveInt(raw.tagId)) return 'tagId must be a positive integer';
  const tagId = raw.tagId;
  switch (raw.op) {
    case 'tag':
    case 'untag':
    case 'clearValues':
      return { op: raw.op, tagId };
    case 'addValue': {
      const value = parseFileValue(raw.value);
      return typeof value === 'string' ? value : { op: 'addValue', tagId, value };
    }
    default:
      return "op must be one of 'tag', 'untag', 'addValue', 'clearValues'";
  }
}

/** The tag ids a value refers to, besides the tag it is on. */
const refTagsOf = (value: FileValueInput) => (value.kind === 'tag' ? [value.refTagId] : []);

/** Adds one value to the instance (fileId, tagId). The single route and the batch route both
 *  call this. Returns the value id. */
export function applyValue(
  db: Db,
  fileId: number,
  tagId: number,
  value: FileValueInput,
  libraryId: number,
): number {
  switch (value.kind) {
    case 'text':
      return tagOps.createTextFileValue(db, fileId, tagId, value.text, libraryId);
    case 'number':
      return tagOps.createNumberFileValue(db, fileId, tagId, value.number, libraryId);
    case 'tag':
      return tagOps.createRefFileValue(db, fileId, tagId, value.refTagId, libraryId);
    case 'anchor':
      return tagOps.createAnchorFileValue(db, fileId, tagId, value.anchor, libraryId);
  }
}

/** Returns the first id in `tagIds` that is not a tag of the library, or null. */
function firstMissingTag(db: Db, tagIds: number[], libraryId: number): number | null {
  for (const tagId of tagIds) {
    const tag = tagOps.getTag(db, tagId);
    if (!tag || tag.library_id !== libraryId) return tagId;
  }
  return null;
}

/** Reads an id array from a body: 1..max positive integers. Returns the ids without
 *  duplicates (first occurrence kept), or an error message. */
function parseIdList(raw: unknown, name: string, max: number): number[] | string {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
    return `${name} must be an array of 1 to ${max} ids`;
  }
  if (!raw.every(isPositiveInt)) return `${name} must contain positive integers only`;
  return [...new Set(raw as number[])];
}

export function libraryFilesRouter({ db }: { db: Db }) {
  const router = Router({ mergeParams: true });
  const canRead = requireCapability('can_read');
  const canTag = requireCapability('can_tag_files');

  const libraryIdOf = (res: Response) => scopeOf(res).library.library_id;

  /** Parses `:fileId` and checks that the file has a location in the library; replies 404
   *  otherwise. */
  const resolveFile = (raw: unknown, res: Response): number | null => {
    const fileId = parseId(raw);
    if (fileId === null || !filesInLibrary(db, [fileId], libraryIdOf(res)).has(fileId)) {
      res.status(404).json({ error: 'File not found' });
      return null;
    }
    return fileId;
  };

  /** Parses `:tagId` and checks that the tag is in the library; replies 404 otherwise. */
  const resolveTag = (raw: unknown, res: Response): number | null => {
    const tagId = parseId(raw);
    if (tagId === null || firstMissingTag(db, [tagId], libraryIdOf(res)) !== null) {
      res.status(404).json({ error: 'Tag not found' });
      return null;
    }
    return tagId;
  };

  //Search and autocomplete

  router.get('/files', canRead, (req, res) => {
    const q = parseQueryString(req.query.q);
    const limit = parseQueryInt(req.query.limit, 100, MAX_PAGE);
    const offset = parseQueryInt(req.query.offset, 0);
    if (q === null) return res.status(400).json({ error: 'q must be a string' });
    if (limit === null || offset === null) {
      return res.status(400).json({ error: 'limit and offset must be non-negative integers' });
    }
    const libraryId = libraryIdOf(res);
    //`count=0` skips the count of all matches: a client that has the total from an earlier
    //page does not need it again.
    const count = req.query.count !== '0';
    try {
      const { total, fileIds } = search(db, q, libraryId, { limit, offset, count });
      res.status(200).json({ total, files: getFileSummaries(db, fileIds, libraryId) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/autocomplete', canRead, (req, res) => {
    const q = parseQueryString(req.query.q);
    const limit = parseQueryInt(req.query.limit, 10, MAX_AUTOCOMPLETE);
    if (q === null) return res.status(400).json({ error: 'q must be a string' });
    if (limit === null)
      return res.status(400).json({ error: 'limit must be a non-negative integer' });
    res.status(200).json(autocomplete(db, q, libraryIdOf(res), limit));
  });

  //Files

  router.post('/files/query', canRead, (req, res) => {
    const { ids: rawIds, include = [] } = req.body ?? {};
    const ids = parseIdList(rawIds, 'ids', MAX_PAGE);
    if (typeof ids === 'string') return res.status(400).json({ error: ids });
    if (!Array.isArray(include) || !include.every((i) => i === 'locations' || i === 'instances')) {
      return res
        .status(400)
        .json({ error: "include must be an array of 'locations' and 'instances'" });
    }
    const libraryId = libraryIdOf(res);
    const summaries = getFileSummaries(db, ids, libraryId);
    const found = summaries.map((s) => s.fileId);
    const locations = include.includes('locations')
      ? getLocationsInLibrary(db, found, libraryId)
      : null;
    const instances = include.includes('instances')
      ? tagOps.getFileInstances(db, found, libraryId)
      : null;
    const tags = instances ? tagOps.getFileInstanceTags(db, instances.values(), libraryId) : null;
    const files = summaries.map(
      (s): FileSummary & { locations?: LocationRecord[]; instances?: FileInstance[] } => ({
        ...s,
        ...(locations && { locations: locations.get(s.fileId) ?? [] }),
        ...(instances && { instances: instances.get(s.fileId) ?? [] }),
      }),
    );
    const foundSet = new Set(found);
    res.status(200).json({
      files,
      notFound: ids.filter((id) => !foundSet.has(id)),
      ...(tags && { tags }),
    });
  });

  router.post('/files/batch', canTag, (req, res) => {
    const { fileIds: rawFileIds, ops: rawOps } = req.body ?? {};
    const fileIds = parseIdList(rawFileIds, 'fileIds', MAX_BATCH_FILES);
    if (typeof fileIds === 'string') return res.status(400).json({ error: fileIds });
    if (!Array.isArray(rawOps) || rawOps.length === 0 || rawOps.length > MAX_BATCH_OPS) {
      return res.status(400).json({ error: `ops must be an array of 1 to ${MAX_BATCH_OPS} ops` });
    }
    const ops: BatchOp[] = [];
    for (const [opIndex, raw] of rawOps.entries()) {
      const op = parseBatchOp(raw);
      if (typeof op === 'string') return res.status(400).json({ error: op, opIndex });
      ops.push(op);
    }

    const libraryId = libraryIdOf(res);
    for (const [opIndex, op] of ops.entries()) {
      const tagIds = [op.tagId, ...(op.op === 'addValue' ? refTagsOf(op.value) : [])];
      const missing = firstMissingTag(db, tagIds, libraryId);
      if (missing !== null) {
        return res.status(404).json({ error: 'Tag not found', opIndex, tagId: missing });
      }
    }
    const inLibrary = filesInLibrary(db, fileIds, libraryId);
    const outsider = fileIds.find((id) => !inLibrary.has(id));
    if (outsider !== undefined) {
      return res.status(404).json({ error: 'File not found', fileId: outsider });
    }

    //Runs the ops in order; each op runs for every file before the next op starts. Any
    //error rolls back the whole batch, and `failed` names the op and file that threw.
    let failed = { opIndex: 0, fileId: 0 };
    try {
      db.transaction(() => {
        for (const [opIndex, op] of ops.entries()) {
          for (const fileId of fileIds) {
            failed = { opIndex, fileId };
            switch (op.op) {
              case 'tag':
                tagOps.tagFile(db, fileId, op.tagId, libraryId);
                break;
              case 'untag':
                tagOps.untagFile(db, fileId, op.tagId, libraryId);
                break;
              case 'addValue':
                //Unlike the single values route (404 when the tag is not applied), a batch
                //addValue applies the tag first, so one op can tag a file and add a value.
                tagOps.tagFile(db, fileId, op.tagId, libraryId);
                applyValue(db, fileId, op.tagId, op.value, libraryId);
                break;
              case 'clearValues':
                tagOps.deleteFileValue(db, fileId, op.tagId);
                break;
            }
          }
        }
      })();
    } catch (err) {
      return sendError(res, err, failed);
    }
    res.status(200).json({ files: getFileSummaries(db, fileIds, libraryId) });
  });

  router.get('/files/:fileId', canRead, (req, res) => {
    const fileId = resolveFile(req.params.fileId, res);
    if (fileId === null) return;
    const libraryId = libraryIdOf(res);
    const instances = tagOps.getFileInstances(db, [fileId], libraryId).get(fileId) ?? [];
    res.status(200).json({
      file: getFileSummaries(db, [fileId], libraryId)[0],
      locations: getLocationsInLibrary(db, [fileId], libraryId).get(fileId) ?? [],
      instances,
      tags: tagOps.getFileInstanceTags(db, [instances], libraryId),
    });
  });

  router.put('/files/:fileId/tags/:tagId', canTag, (req, res) => {
    const fileId = resolveFile(req.params.fileId, res);
    if (fileId === null) return;
    const tagId = resolveTag(req.params.tagId, res);
    if (tagId === null) return;
    try {
      tagOps.tagFile(db, fileId, tagId, libraryIdOf(res));
    } catch (err) {
      return sendError(res, err);
    }
    res.status(204).send();
  });

  router.delete('/files/:fileId/tags/:tagId', canTag, (req, res) => {
    const fileId = resolveFile(req.params.fileId, res);
    if (fileId === null) return;
    const tagId = resolveTag(req.params.tagId, res);
    if (tagId === null) return;
    try {
      tagOps.untagFile(db, fileId, tagId, libraryIdOf(res));
    } catch (err) {
      return sendError(res, err);
    }
    res.status(204).send();
  });

  router.post('/files/:fileId/tags/:tagId/values', canTag, (req, res) => {
    const fileId = resolveFile(req.params.fileId, res);
    if (fileId === null) return;
    const tagId = resolveTag(req.params.tagId, res);
    if (tagId === null) return;
    const value = parseFileValue(req.body);
    if (typeof value === 'string') return res.status(400).json({ error: value });
    const libraryId = libraryIdOf(res);
    if (firstMissingTag(db, refTagsOf(value), libraryId) !== null) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    let valueId: number;
    try {
      //Strict: the tag must already be applied to the file (404 otherwise).
      valueId = applyValue(db, fileId, tagId, value, libraryId);
    } catch (err) {
      return sendError(res, err);
    }
    const created: FileValue | undefined = tagOps
      .getFileInstances(db, [fileId], libraryId)
      .get(fileId)
      ?.find((i) => i.tagId === tagId)
      ?.values.find((v) => v.valueId === valueId);
    res.status(201).json({ value: created });
  });

  router.patch('/files/:fileId/values/:valueId', canTag, (req, res) => {
    const fileId = resolveFile(req.params.fileId, res);
    if (fileId === null) return;
    const valueId = parseId(req.params.valueId);
    if (valueId === null) return res.status(404).json({ error: 'Value not found' });
    const value = parseFileValue(req.body);
    if (typeof value === 'string') return res.status(400).json({ error: value });
    const libraryId = libraryIdOf(res);
    if (firstMissingTag(db, refTagsOf(value), libraryId) !== null) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    try {
      tagOps.updateFileValueById(db, fileId, valueId, value, libraryId);
    } catch (err) {
      return sendError(res, err);
    }
    const updated: FileValue | undefined = tagOps
      .getFileInstances(db, [fileId], libraryId)
      .get(fileId)
      ?.flatMap((i) => i.values)
      .find((v) => v.valueId === valueId);
    res.status(200).json({ value: updated });
  });

  router.delete('/files/:fileId/values/:valueId', canTag, (req, res) => {
    const fileId = resolveFile(req.params.fileId, res);
    if (fileId === null) return;
    const valueId = parseId(req.params.valueId);
    if (valueId === null) return res.status(404).json({ error: 'Value not found' });
    try {
      tagOps.deleteFileValueById(db, fileId, valueId, libraryIdOf(res));
    } catch (err) {
      return sendError(res, err);
    }
    res.status(204).send();
  });

  return router;
}
