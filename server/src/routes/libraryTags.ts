//Library-scoped routes for the tag vocabulary: tags, aliases, parents, components and the
//tags applied to tags. Mounted under /api/libraries/:libraryId behind libraryScope.

import { Router, type Response } from 'express';
import type { Db } from '../db/index.ts';
import * as tagOps from '../db/tagging_operations.ts';
import type { TagValue, TagValueUpdate } from '../db/tagging_operations.ts';
import { requireCapability, scopeOf } from './libraryScope.ts';
import { isPositiveInt, parseId, parseQueryInt, parseQueryString, sendError } from './util.ts';

export const MAX_TAG_PAGE = 500;

/** The body of a new tag-tag value. */
export type TagValueInput =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'tag'; refTagId: number };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOptionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean';

/** Checks the shape of a tag value body. Returns the value, or an error message. */
function parseTagValue(body: unknown): TagValueInput | string {
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
    default:
      return "kind must be one of 'text', 'number', 'tag'";
  }
}

/** Checks the shape of a tag value update body. Returns the update, or an error message. */
function parseTagValueUpdate(body: unknown): TagValueUpdate | string {
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
    case 'parent':
      return typeof body.primary === 'boolean'
        ? { kind: 'parent', primary: body.primary }
        : 'primary must be a boolean';
    case 'component':
      return typeof body.recursive === 'boolean' && typeof body.attributed === 'boolean'
        ? { kind: 'component', recursive: body.recursive, attributed: body.attributed }
        : 'recursive and attributed must be booleans';
    default:
      return "kind must be one of 'text', 'number', 'tag', 'parent', 'component'";
  }
}

/** The value of `kind` on the instance of `tagId` on `subjectTagId`, if any. */
function findTagValue(
  db: Db,
  subjectTagId: number,
  tagId: number,
  libraryId: number,
  kind: TagValue['kind'],
): TagValue | undefined {
  return tagOps
    .getTagDetail(db, subjectTagId, libraryId)
    .instances.find((i) => i.tagId === tagId)
    ?.values.find((v) => v.kind === kind);
}

export function libraryTagsRouter({ db }: { db: Db }) {
  const router = Router({ mergeParams: true });
  const canRead = requireCapability('can_read');
  const canWrite = requireCapability('can_create_tag');

  const libraryIdOf = (res: Response) => scopeOf(res).library.library_id;

  /** Parses each raw path id and checks that it is a tag of the library. Replies 404 and
   *  returns null when one is not. */
  const resolveTags = (res: Response, ...raw: unknown[]): number[] | null => {
    const libraryId = libraryIdOf(res);
    const ids: number[] = [];
    for (const r of raw) {
      const id = parseId(r);
      const tag = id === null ? undefined : tagOps.getTag(db, id);
      if (id === null || !tag || tag.library_id !== libraryId) {
        res.status(404).json({ error: 'Tag not found' });
        return null;
      }
      ids.push(id);
    }
    return ids;
  };

  const detail = (res: Response, tagId: number) => tagOps.getTagDetail(db, tagId, libraryIdOf(res));

  /** Runs a write; replies via sendError when it throws. Returns false on error. */
  const attempt = (res: Response, write: () => void): boolean => {
    try {
      write();
      return true;
    } catch (err) {
      sendError(res, err);
      return false;
    }
  };

  //Tags

  router.get('/tags', canRead, (req, res) => {
    const q = parseQueryString(req.query.q);
    const limit = parseQueryInt(req.query.limit, 100, MAX_TAG_PAGE);
    const offset = parseQueryInt(req.query.offset, 0);
    if (q === null) return res.status(400).json({ error: 'q must be a string' });
    if (limit === null || offset === null) {
      return res.status(400).json({ error: 'limit and offset must be non-negative integers' });
    }
    res.status(200).json(tagOps.listTags(db, libraryIdOf(res), { q, limit, offset }));
  });

  router.get('/tag-graph', canRead, (_req, res) => {
    res.status(200).json(tagOps.getTagGraph(db, libraryIdOf(res)));
  });

  router.post('/tags', canWrite, (req, res) => {
    const { alias, color, isCategory, parentId, wikiText } = req.body ?? {};
    if (typeof alias !== 'string') return res.status(400).json({ error: 'alias is required' });
    if (color !== undefined && color !== null && typeof color !== 'string') {
      return res.status(400).json({ error: 'color must be a string or null' });
    }
    if (!isOptionalBoolean(isCategory)) {
      return res.status(400).json({ error: 'isCategory must be a boolean' });
    }
    if (parentId !== undefined && !isPositiveInt(parentId)) {
      return res.status(400).json({ error: 'parentId must be a positive integer' });
    }
    if (wikiText !== undefined && typeof wikiText !== 'string') {
      return res.status(400).json({ error: 'wikiText must be a string' });
    }
    const libraryId = libraryIdOf(res);
    if (parentId !== undefined && !resolveTags(res, String(parentId))) return;
    let tagId = 0;
    const ok = attempt(res, () => {
      tagId = tagOps.createTag(db, { alias, libraryId, color, isCategory, parentId, wikiText });
    });
    if (ok) res.status(201).json({ tag: detail(res, tagId) });
  });

  router.get('/tags/:tagId', canRead, (req, res) => {
    const ids = resolveTags(res, req.params.tagId);
    if (!ids) return;
    res.status(200).json({ tag: detail(res, ids[0]!) });
  });

  router.patch('/tags/:tagId', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId);
    if (!ids) return;
    const { color, isCategory, wikiText } = req.body ?? {};
    if (color !== undefined && color !== null && typeof color !== 'string') {
      return res.status(400).json({ error: 'color must be a string or null' });
    }
    if (!isOptionalBoolean(isCategory)) {
      return res.status(400).json({ error: 'isCategory must be a boolean' });
    }
    if (wikiText !== undefined && typeof wikiText !== 'string') {
      return res.status(400).json({ error: 'wikiText must be a string' });
    }
    const [tagId] = ids as [number];
    if (
      attempt(res, () =>
        tagOps.updateTag(db, tagId, libraryIdOf(res), { color, isCategory, wikiText }),
      )
    ) {
      res.status(200).json({ tag: detail(res, tagId) });
    }
  });

  router.delete('/tags/:tagId', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId);
    if (!ids) return;
    if (attempt(res, () => tagOps.deleteTag(db, ids[0]!, libraryIdOf(res)))) {
      res.status(204).send();
    }
  });

  //Aliases

  router.post('/tags/:tagId/aliases', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId);
    if (!ids) return;
    const { text } = req.body ?? {};
    if (typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
    const [tagId] = ids as [number];
    if (attempt(res, () => tagOps.addAlias(db, tagId, text, libraryIdOf(res)))) {
      res.status(201).json({ tag: detail(res, tagId) });
    }
  });

  router.patch('/tags/:tagId/aliases/:aliasId', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId);
    if (!ids) return;
    const aliasId = parseId(req.params.aliasId);
    if (aliasId === null) return res.status(404).json({ error: 'Alias not found' });
    const { text, primary, shorthand } = req.body ?? {};
    if (text !== undefined && typeof text !== 'string') {
      return res.status(400).json({ error: 'text must be a string' });
    }
    if (!isOptionalBoolean(primary) || !isOptionalBoolean(shorthand)) {
      return res.status(400).json({ error: 'primary and shorthand must be booleans' });
    }
    if (primary === false && shorthand !== true) {
      return res.status(400).json({ error: 'primary can only be set to true' });
    }
    const [tagId] = ids as [number];
    const libraryId = libraryIdOf(res);
    const ok = attempt(res, () =>
      db.transaction(() => {
        tagOps.getAliasById(db, tagId, aliasId, libraryId);
        if (text !== undefined) tagOps.updateAliasText(db, tagId, aliasId, text, libraryId);
        const alias = tagOps.getAliasById(db, tagId, aliasId, libraryId);
        if (primary === true) tagOps.setAliasPrimary(db, tagId, alias.text, libraryId);
        if (shorthand === true) tagOps.setAliasShorthand(db, tagId, alias.text, libraryId);
        if (shorthand === false) tagOps.clearAliasShorthand(db, tagId, aliasId, libraryId);
        if (primary === false && shorthand === true) {
          tagOps.clearAliasPrimary(db, tagId, aliasId, libraryId);
        }
      })(),
    );
    if (ok) res.status(200).json({ tag: detail(res, tagId) });
  });

  router.delete('/tags/:tagId/aliases/:aliasId', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId);
    if (!ids) return;
    const aliasId = parseId(req.params.aliasId);
    if (aliasId === null) return res.status(404).json({ error: 'Alias not found' });
    if (attempt(res, () => tagOps.deleteAliasById(db, ids[0]!, aliasId, libraryIdOf(res)))) {
      res.status(204).send();
    }
  });

  //Parents

  router.put('/tags/:tagId/parents/:parentId', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId, req.params.parentId);
    if (!ids) return;
    const { primary } = req.body ?? {};
    if (!isOptionalBoolean(primary)) {
      return res.status(400).json({ error: 'primary must be a boolean' });
    }
    const [tagId, parentId] = ids as [number, number];
    const libraryId = libraryIdOf(res);
    //Idempotent: an existing parent only changes when `primary` is explicitly passed.
    const ok = attempt(res, () => {
      if (findTagValue(db, tagId, parentId, libraryId, 'parent')) {
        if (primary !== undefined) tagOps.setParentPrimary(db, tagId, parentId, primary);
      } else {
        tagOps.createParentTagValue(db, tagId, parentId, { primary: primary === true });
      }
    });
    if (ok) res.status(204).send();
  });

  router.delete('/tags/:tagId/parents/:parentId', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId, req.params.parentId);
    if (!ids) return;
    const [tagId, parentId] = ids as [number, number];
    if (!findTagValue(db, tagId, parentId, libraryIdOf(res), 'parent')) {
      return res.status(404).json({ error: 'Parent not found' });
    }
    if (attempt(res, () => tagOps.deleteTagValuesOfKind(db, tagId, parentId, 'parent'))) {
      res.status(204).send();
    }
  });

  //Components

  router.put('/tags/:tagId/components/:componentId', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId, req.params.componentId);
    if (!ids) return;
    const { recursive, attributed } = req.body ?? {};
    if (!isOptionalBoolean(recursive) || !isOptionalBoolean(attributed)) {
      return res.status(400).json({ error: 'recursive and attributed must be booleans' });
    }
    const [tagId, componentId] = ids as [number, number];
    const ok = attempt(res, () =>
      tagOps.createComponentTagValue(db, tagId, componentId, { recursive, attributed }),
    );
    if (ok) res.status(204).send();
  });

  router.delete('/tags/:tagId/components/:componentId', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId, req.params.componentId);
    if (!ids) return;
    const [tagId, componentId] = ids as [number, number];
    if (!findTagValue(db, tagId, componentId, libraryIdOf(res), 'component')) {
      return res.status(404).json({ error: 'Component not found' });
    }
    if (attempt(res, () => tagOps.deleteTagValuesOfKind(db, tagId, componentId, 'component'))) {
      res.status(204).send();
    }
  });

  //Tags applied to tags

  router.put('/tags/:tagId/tags/:refTagId', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId, req.params.refTagId);
    if (!ids) return;
    const [tagId, refTagId] = ids as [number, number];
    if (attempt(res, () => tagOps.tagTag(db, tagId, refTagId))) res.status(204).send();
  });

  router.delete('/tags/:tagId/tags/:refTagId', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId, req.params.refTagId);
    if (!ids) return;
    const [tagId, refTagId] = ids as [number, number];
    if (attempt(res, () => tagOps.untagTag(db, tagId, refTagId))) res.status(204).send();
  });

  router.post('/tags/:tagId/tags/:refTagId/values', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId, req.params.refTagId);
    if (!ids) return;
    const value = parseTagValue(req.body);
    if (typeof value === 'string') return res.status(400).json({ error: value });
    if (value.kind === 'tag' && !resolveTags(res, String(value.refTagId))) return;
    const [subjectTagId, tagId] = ids as [number, number];
    let valueId = 0;
    const ok = attempt(res, () => {
      switch (value.kind) {
        case 'text':
          valueId = tagOps.createTextTagValue(db, subjectTagId, tagId, value.text);
          break;
        case 'number':
          valueId = tagOps.createNumberTagValue(db, subjectTagId, tagId, value.number);
          break;
        case 'tag':
          valueId = tagOps.createRefTagValue(db, subjectTagId, tagId, value.refTagId);
          break;
      }
    });
    if (!ok) return;
    const created = detail(res, subjectTagId)
      .instances.find((i) => i.tagId === tagId)
      ?.values.find((v) => v.valueId === valueId);
    res.status(201).json({ value: created });
  });

  router.patch('/tags/:tagId/values/:valueId', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId);
    if (!ids) return;
    const valueId = parseId(req.params.valueId);
    if (valueId === null) return res.status(404).json({ error: 'Value not found' });
    const value = parseTagValueUpdate(req.body);
    if (typeof value === 'string') return res.status(400).json({ error: value });
    if (value.kind === 'tag' && !resolveTags(res, String(value.refTagId))) return;
    const [subjectTagId] = ids as [number];
    const libraryId = libraryIdOf(res);
    const ok = attempt(res, () => {
      tagOps.updateTagValueById(db, subjectTagId, valueId, value, libraryId);
    });
    if (!ok) return;
    const updated = detail(res, subjectTagId)
      .instances.flatMap((i) => i.values)
      .find((v) => v.valueId === valueId);
    res.status(200).json({ value: updated });
  });

  router.delete('/tags/:tagId/values/:valueId', canWrite, (req, res) => {
    const ids = resolveTags(res, req.params.tagId);
    if (!ids) return;
    const valueId = parseId(req.params.valueId);
    if (valueId === null) return res.status(404).json({ error: 'Value not found' });
    if (attempt(res, () => tagOps.deleteTagValueById(db, ids[0]!, valueId))) {
      res.status(204).send();
    }
  });

  return router;
}
