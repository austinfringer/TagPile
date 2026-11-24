//Routes for looking up files in the library directly.
//search and tag are different.

import { Router } from 'express';
import sharp from 'sharp';
import type { Db } from '../db/index.ts';
import { getVisibleFile, getVisibleLocations, getVisibleTags } from '../db/file_operations.ts';
import { accessibleLibraryIds } from '../db/library_operations.ts';
import { findContent } from './content.ts';
import { parseId, userIdOf } from './util.ts';

type FilesDeps = {
  db: Db;
};

/** Extensions a browser renders natively, mapped to their content type. Originals of these
 *  types are served unconverted; anything else sharp understands is converted to PNG. */
const WEB_READY_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** Every content response gets these. A script in an SVG does not run, even when a user opens
 *  the content URL directly, because the sandbox gives the document a unique origin. */
const CONTENT_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, max-age=3600',
};

export function filesRouter({ db }: FilesDeps) {
  const router = Router();

  router.get('/files/:id', (req, res) => {
    const fileId = parseId(req.params.id);
    if (fileId === null) return res.status(400).json({ error: 'File id must be an integer' });
    const libraryIds = accessibleLibraryIds(db, userIdOf(req));

    //A file is visible only through locations in libraries the caller belongs to; anything
    //else is indistinguishable from a file that does not exist.
    const file = getVisibleFile(db, fileId, libraryIds);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.status(200).json({
      file: {
        ...file,
        locations: getVisibleLocations(db, fileId, libraryIds),
        tags: getVisibleTags(db, fileId, libraryIds),
      },
    });
  });

  /** Serves the file's full content as a displayable image: web-ready originals go out
   *  unchanged, other images are converted to PNG, and non-image content answers 415. */
  router.get('/files/:id/content', async (req, res) => {
    const fileId = parseId(req.params.id);
    if (fileId === null) return res.status(400).json({ error: 'File id must be an integer' });
    const libraryIds = accessibleLibraryIds(db, userIdOf(req));

    //Like every file route, content is visible only through a location in one of the
    //caller's libraries; anything else is indistinguishable from a file that does not exist.
    const location = await findContent(db, { fileId }, libraryIds);
    if (!location) return res.status(404).json({ error: 'File not found' });

    res.set(CONTENT_HEADERS);
    const webReady = WEB_READY_MIME[location.extension];
    if (webReady) {
      //sendFile streams the file and answers Range requests. It keeps a Content-Type that is
      //already set.
      res.setHeader('Content-Type', webReady);
      return res.sendFile(location.fullPath, { dotfiles: 'allow', cacheControl: false });
    }

    //Not natively displayable: convert, if the content is an image at all. sharp reads the
    //file itself, so a large file is not loaded into memory first.
    try {
      const converted = await sharp(location.fullPath).png().toBuffer();
      res.setHeader('Content-Type', 'image/png');
      return res.send(converted);
    } catch {
      res.removeHeader('Cache-Control');
      return res.status(415).json({ error: 'File content is not a displayable image' });
    }
  });

  return router;
}
