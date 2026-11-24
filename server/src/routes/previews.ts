//Routes for the preview cache: one preview per request, or a batch for grids. Previews are
//content-addressed, but both endpoints resolve their inputs through the caller's visible
//libraries first, so a preview never crosses a visibility boundary.
//
//A file with no preview (a non-image type, or anything that could not be generated) answers
//204 on the single route and is omitted from the batch response. The client falls back to its
//placeholder in both cases.

import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { Db } from '../db/index.ts';
import { NotFoundError } from '../db/errors.ts';
import { getVisibleFile } from '../db/file_operations.ts';
import { accessibleLibraryIds } from '../db/library_operations.ts';
import type { PreviewRow, PreviewService } from '../services/previewService.ts';
import { findContent } from './content.ts';
import { isPositiveInt, parseId, sendError, userIdOf } from './util.ts';

type PreviewsDeps = {
  db: Db;
  previewService: PreviewService;
};

export const MAX_BATCH_PREVIEWS = 500;

/** Larger originals get no preview, so one huge file cannot fill the server's memory. */
export const MAX_PREVIEW_SOURCE_BYTES = 256 * 1024 * 1024;

const FORMAT_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Content type for a stored preview row. Generated previews are always webp; rows holding the
 *  original bytes keep the original format, which is sniffed from the content. */
async function contentTypeFor(row: PreviewRow): Promise<string> {
  if (row.type !== 'image') return 'application/octet-stream';
  if (!row.is_original) return 'image/webp';
  const { format } = await sharp(row.preview).metadata();
  return (format && FORMAT_MIME[format]) ?? 'application/octet-stream';
}

/** Builds the `getOriginal` callback the preview service expects. Reads the bytes from a
 *  non-missing location in a library the caller can read (see `findContent`). */
function originalLookup(db: Db, libraryIds: readonly number[]) {
  return async (hash: string): Promise<{ buffer: Buffer; extension: string }> => {
    const location = await findContent(db, { fileHash: hash }, libraryIds);
    if (!location) throw new NotFoundError('File not found');
    if (location.size > MAX_PREVIEW_SOURCE_BYTES) throw new NotFoundError('File too large');
    return { buffer: await readFile(location.fullPath), extension: location.extension };
  };
}

export function previewsRouter({ db, previewService }: PreviewsDeps) {
  const router = Router();

  router.get('/previews/:id', async (req, res) => {
    const fileId = parseId(req.params.id);
    if (fileId === null) return res.status(400).json({ error: 'File id must be an integer' });
    const libraryIds = accessibleLibraryIds(db, userIdOf(req));
    const file = getVisibleFile(db, fileId, libraryIds);
    if (!file) return res.status(404).json({ error: 'File not found' });
    try {
      const rows = await previewService.getPreviews(
        [file.file_hash],
        originalLookup(db, libraryIds),
      );
      const row = rows.find((r) => r.hash === file.file_hash);
      if (!row || row.preview.length === 0) return res.status(204).send();
      res.setHeader('Content-Type', await contentTypeFor(row));
      res.send(row.preview);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/previews', async (req, res) => {
    const rawIds: unknown = req.body?.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_BATCH_PREVIEWS) {
      return res
        .status(400)
        .json({ error: `ids must be an array of 1 to ${MAX_BATCH_PREVIEWS} ids` });
    }
    if (!rawIds.every(isPositiveInt)) {
      return res.status(400).json({ error: 'ids must contain positive integers only' });
    }
    const ids = [...new Set(rawIds as number[])];
    const libraryIds = accessibleLibraryIds(db, userIdOf(req));
    const getOriginal = originalLookup(db, libraryIds);

    const previews: { fileId: number; type: string; mime: string; data: string }[] = [];
    const notFound: number[] = [];
    for (const fileId of ids) {
      const file = getVisibleFile(db, fileId, libraryIds);
      if (!file) {
        notFound.push(fileId);
        continue;
      }
      //Generate per file, so one unreadable or corrupt original does not sink the whole batch.
      try {
        const rows = await previewService.getPreviews([file.file_hash], getOriginal);
        const row = rows.find((r) => r.hash === file.file_hash);
        if (row && row.preview.length > 0) {
          previews.push({
            fileId,
            type: row.type,
            mime: await contentTypeFor(row),
            data: row.preview.toString('base64'),
          });
        }
      } catch {
        //No preview for this file: the client uses its placeholder.
      }
    }
    res.status(200).json({ previews, notFound });
  });

  return router;
}
