import type Database from 'better-sqlite3';
import sharp from 'sharp';

export type PreviewRow = {
  hash: string;
  preview: Buffer;
  type: string;
  is_original: number;
};

export type PreviewSettings = {
  maxSize: number;
};

/** Rows kept in the cache. It must be larger than one batch request (`MAX_BATCH_PREVIEWS`),
 *  or the cleanup deletes previews that the same request just made. */
export const DEFAULT_PREVIEW_CACHE_SIZE = 2000;

export class PreviewService {
  private db: Database.Database;
  private settings: PreviewSettings;

  constructor(
    database: Database.Database,
    settings: PreviewSettings = { maxSize: DEFAULT_PREVIEW_CACHE_SIZE },
  ) {
    this.db = database;
    this.createTables();
    this.settings = settings;
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS previews (
        hash TEXT PRIMARY KEY,
        preview BLOB NOT NULL,
        type TEXT NOT NULL,
        is_original BOOLEAN NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
  }

  private async generatePreview(
    hash: string,
    getOriginal: (hash: string) => Promise<{ buffer: Buffer; extension: string }>,
  ) {
    const { buffer, extension } = await getOriginal(hash);
    const ext = extension.toLowerCase();
    let previewBuffer: Buffer = Buffer.alloc(0);
    let type: string;
    let is_original;

    if (ext === 'png' || ext === 'jpeg' || ext === 'jpg' || ext === 'webp') {
      type = 'image';

      //Check to see if the image needs a preview, or if it's small enough to be used as-is
      const { width, height } = await sharp(buffer).metadata();
      if (width && height && width <= 512 && height <= 512 && buffer.length <= 1024 * 1024) {
        previewBuffer = buffer;
        is_original = 1;
      } else {
        previewBuffer = await this.createImagePreview(buffer);
        is_original = 0;
      }
    } else {
      type = ext;
      is_original = 0;
    }
    await this.savePreview(hash, previewBuffer, type, is_original);

    const newRow = {
      hash: hash,
      preview: previewBuffer,
      type: type,
      is_original: is_original,
    };

    return newRow;
  }

  private async savePreview(hash: string, preview: Buffer, type: string, is_original = 0) {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO previews (hash, preview, type, is_original) VALUES (?, ?, ?, ?)',
    );
    stmt.run(hash, preview, type, is_original);
  }

  private async createImagePreview(original: Buffer) {
    const preview = await sharp(original).resize(256, 256).toFormat('webp').toBuffer();
    return preview;
  }

  //Just make the preview for the given file hash
  public async preparePreview(
    hash: string,
    getOriginal: (hash: string) => Promise<{ buffer: Buffer; extension: string }>,
  ) {
    await this.generatePreview(hash, getOriginal);
  }

  public async getPreviews(
    fileHashes: string[],
    getOriginal: (hash: string) => Promise<{ buffer: Buffer; extension: string }>,
  ): Promise<PreviewRow[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM previews WHERE hash IN (' + fileHashes.map(() => '?').join(',') + ')',
    );
    const rows = stmt.all(fileHashes) as PreviewRow[];

    //Check each filehash to see if it has a row in the output
    const missingHashes = fileHashes.filter((hash) => !rows.some((row) => row.hash === hash));

    //for each missingHash, we need to generate the preview, and add it to the response
    for (const hash of missingHashes) {
      const newRow = await this.generatePreview(hash, getOriginal);
      rows.push(newRow);
    }
    if (missingHashes.length > 0) await this.clearUnused();

    return rows;
  }

  private async clearUnused() {
    const stmt = this.db.prepare(
      `DELETE FROM previews WHERE hash NOT IN (SELECT hash FROM previews ORDER BY created_at DESC LIMIT ${this.settings.maxSize})`,
    );
    stmt.run();
  }
}
