import type { Job, JobCallbacks, JobModule, JobStatus } from '../services/jobManager.ts';
import type { Db } from '../db/index.ts';
import * as fileOps from '../db/file_operations.ts';
import * as libOps from '../db/library_operations.ts';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as Path from 'node:path';

export type LibraryScanOptions = {
  libraryId: number; //Library this scan is for
  ignorePaths?: string[]; //Paths/files to ignore
  subpath?: string; //Directory to scan, relative to the library root. Omit to scan the whole root.
};

//The subset of node:fs.Stats the scan needs (epoch ms); real Stats satisfy this.
export interface ScanStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  birthtimeMs: number;
  mtimeMs: number;
}

//The subset of node:fs the scan needs; injectable so tests can avoid disk IO.
//The walk uses lstatSync and never follows a symbolic link, so a link in a library cannot
//expose files outside the root or make the walk loop.
export interface ScanFs {
  lstatSync(path: string): ScanStats;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
  readFileSync(path: string): Buffer;
  openSync(path: string, flags: number): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}

//O_NOFOLLOW makes open fail on a link that replaced the file after the lstat. Windows has no
//such flag; there the lstat check is the only guard.
export const OPEN_NO_FOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

/** Bytes hashed in one job step. Large files take many steps, so the server stays responsive
 *  and memory use stays bounded. */
export const HASH_CHUNK_SIZE = 16 * 1024 * 1024;

/** A relative path that stays inside the root: no absolute paths, no `..` segments. */
export function isSafeSubpath(subpath: string): boolean {
  if (Path.isAbsolute(subpath)) return false;
  const normalized = Path.normalize(subpath);
  return normalized !== '..' && !normalized.startsWith('..' + Path.sep);
}

/** Turns a glob pattern (`*` any chars, `?` one char) into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Builds the ignore-list predicate for root-relative paths. A pattern matches when it
 * matches the full relative path or just the entry's name, so `node_modules` ignores the
 * folder anywhere and `*.tmp` ignores the type anywhere.
 */
export function makeIgnoreMatcher(ignorePaths: string[]): (path: string) => boolean {
  const matchers = ignorePaths
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => globToRegExp(p.replace(/\\/g, '/')));
  if (matchers.length === 0) return () => false;
  return (path: string) => {
    const normalized = path.replace(/\\/g, '/');
    const name = normalized.split('/').pop() ?? normalized;
    return matchers.some((re) => re.test(normalized) || re.test(name));
  };
}

export default class LibraryScanModule implements JobModule<LibraryScanOptions> {
  name = 'library-scan';
  private fs: ScanFs;
  private chunkSize: number;

  constructor({
    fs: scanFs = fs,
    chunkSize = HASH_CHUNK_SIZE,
  }: { fs?: ScanFs; chunkSize?: number } = {}) {
    this.fs = scanFs;
    this.chunkSize = chunkSize;
  }

  parseOptions(raw: unknown): LibraryScanOptions {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Library scan options must be an object');
    }
    const { libraryId, ignorePaths, subpath } = raw as Record<string, unknown>;
    const isStringArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((s) => typeof s === 'string');

    if (typeof libraryId !== 'number' || !Number.isInteger(libraryId)) {
      throw new Error('libraryId must be an integer');
    }
    if (ignorePaths !== undefined && !isStringArray(ignorePaths)) {
      throw new Error('ignorePaths must be an array of strings');
    }
    if (subpath !== undefined && (typeof subpath !== 'string' || !isSafeSubpath(subpath))) {
      throw new Error('subpath must be a relative path inside the library root');
    }
    return { libraryId, ignorePaths, subpath };
  }

  createJob(options: LibraryScanOptions, db: Db, callbacks: JobCallbacks) {
    return new LibraryScanJob(options, db, callbacks, this.fs, this.chunkSize) as Job;
  }
}

/** A file whose hash is being computed over several steps. */
type PendingHash = {
  path: string;
  stat: ScanStats;
  fd: number;
  hash: crypto.Hash;
  size: number;
};

class LibraryScanJob implements Job {
  private db: Db;
  private options: LibraryScanOptions;
  private callbacks: JobCallbacks;
  private fs: ScanFs;
  private chunk: Buffer;
  private pending: PendingHash | null = null;

  private paths: string[];
  private subpath: string; //normalized; '.' means the whole root
  private reverseRecords: fileOps.LocationRecord[];
  private libraryRecord: libOps.LibraryRecord;
  private scanStartTime: number;
  private internalState: 'forward' | 'reverse' | 'complete';
  private isIgnored: (path: string) => boolean;

  private scanStatus = {
    state: 'running',
    message: 'running...',
    filesScanned: 0, //total files touched
    entriesIgnored: 0, //files/dirs skipped by the ignore list
    entriesSkipped: 0, //symbolic links and other entries that are not regular files or dirs
    filesCreated: 0, //A new location and hash, brand new file
    filesMigrated: 0, //A location associated with a file, has a new hash (new file, tags coppied)
    duplicateFiles: 0, //New location, known hash, (location added to existing file)
    idleFiles: 0, //File+Location Known, no changes.
    missingLocations: 0, //File+Location Known, but file is missing
    staleLocationsOnDisk: 0, //Location is stale, but file is not missing (should not happen)
    //Capped event lists for the job detail view (dup: new path + its sibling paths)
    duplicates: [] as { path: string; siblings: string[] }[],
    migrated: [] as { path: string }[],
  };

  constructor(
    options: LibraryScanOptions,
    db: Db,
    callbacks: JobCallbacks,
    scanFs: ScanFs,
    chunkSize: number,
  ) {
    this.db = db;
    this.options = options;
    this.fs = scanFs;
    this.chunk = Buffer.alloc(chunkSize);

    this.callbacks = callbacks;
    this.subpath = Path.normalize(options.subpath || '.').replace(/[\\/]+$/, '') || '.';
    this.paths = [this.subpath];
    this.reverseRecords = [];
    const record = libOps.getLibraryById(this.db, this.options.libraryId);
    if (!record) {
      throw new Error('Library not found');
    }
    this.libraryRecord = record;
    this.internalState = 'forward';
    this.scanStartTime = Date.now();
    this.isIgnored = makeIgnoreMatcher(options.ignorePaths ?? []);
  }

  //pick a path from the list and scan it
  //if its a dir, we expand it
  //if its a file, we scan it and log it
  execute() {
    //no more paths to scan, now we reverse scan
    try {
      if (this.paths.length === 0 && !this.pending && this.internalState === 'forward') {
        this.internalState = 'reverse';
        //Ignored paths are never visited by the forward walk, so they are always stale.
        //Leaving them out also leaves a now-ignored, previously scanned file untouched.
        this.reverseRecords = fileOps
          .getStaleLocations(
            this.db,
            this.options.libraryId,
            this.scanStartTime,
            this.subpath === '.' ? [] : [this.subpath + Path.sep],
          )
          .filter((record) => !this.isIgnored(record.path));
      }

      if (this.reverseRecords.length === 0 && this.internalState === 'reverse') {
        this.internalState = 'complete';
        this.scanStatus.state = 'complete';
        this.callbacks.jobComplete();
        return;
      }

      if (this.internalState === 'reverse') {
        const record = this.reverseRecords[this.reverseRecords.length - 1];
        if (!record) {
          //should not happen, but just in case
          return;
        }
        //we have a stale record that hasn't been visited in the forward scan
        //This location is probably missing, but lets validate it
        this.checkLocation(record);
        this.reverseRecords.pop();
      }

      if (this.internalState == 'forward' && this.pending) {
        this.continueHash(this.pending);
      } else if (this.internalState == 'forward') {
        const path = this.paths.pop();
        if (path === undefined) {
          //should not happen, but just in case
          return;
        }
        //An ignored directory is never expanded, so nothing under it is scanned.
        if (this.isIgnored(path)) {
          this.scanStatus.entriesIgnored++;
          this.callbacks.stepComplete();
          return;
        }
        const fullPath = Path.join(this.libraryRecord.root_path, path);
        const stat = this.fs.lstatSync(fullPath);
        if (stat.isDirectory()) {
          this.expandDirectory(path);
        } else if (stat.isFile()) {
          const fd = this.fs.openSync(fullPath, OPEN_NO_FOLLOW);
          this.pending = { path, stat, fd, hash: crypto.createHash('sha256'), size: 0 };
          this.continueHash(this.pending);
        } else {
          this.scanStatus.entriesSkipped++;
        }
      }
    } catch (error) {
      this.closePending();
      console.error('Error during scan:', error);
      this.scanStatus.message = 'Error during scan';
      this.scanStatus.state = 'error';
      this.callbacks.jobFailed(error);
    }
    this.callbacks.stepComplete();
  }

  //Event lists live inside status_data, which is persisted as JSON on completion; keep them
  //capped so a huge library can't blow up the payload.
  private static MAX_EVENTS = 100;

  private recordEvent<T>(list: T[], event: T) {
    if (list.length < LibraryScanJob.MAX_EVENTS) {
      list.push(event);
    }
  }

  private expandDirectory(path: string) {
    const newPaths = this.fs.readdirSync(Path.join(this.libraryRecord.root_path, path));
    //Path.join normalizes, so entries under '.' come out as plain relative paths
    this.paths.push(...newPaths.map((p) => Path.join(path, p)));
  }

  /** Hashes the next chunk of the pending file. Records the file when its end is reached. */
  private continueHash(pending: PendingHash) {
    const read = this.fs.readSync(pending.fd, this.chunk, 0, this.chunk.length, pending.size);
    pending.hash.update(this.chunk.subarray(0, read));
    pending.size += read;
    //A full chunk may not be the end of the file; read again in the next step.
    if (read === this.chunk.length) return;
    this.closePending();
    this.scanFile(pending.path, pending.stat, pending.hash.digest('hex'), pending.size);
  }

  private closePending() {
    if (!this.pending) return;
    const { fd } = this.pending;
    this.pending = null;
    this.fs.closeSync(fd);
  }

  private checkLocation(location: fileOps.LocationRecord) {
    //Go to the location and check if the file still exists
    const filePath = Path.join(this.libraryRecord.root_path, location.path);
    if (!this.fs.existsSync(filePath)) {
      //File is missing, mark it as missing
      fileOps.updateLocationMissing(this.db, location.location_id);
      this.scanStatus.missingLocations++;
    } else {
      this.scanStatus.staleLocationsOnDisk++;
    }
  }

  //this is the forward scanning logic, we are looking at the files that exist
  //Once complete, we will check the database for locations in the scan path that were not found
  private scanFile(path: string, stat: ScanStats, fileHash: string, size: number) {
    const metadata = fileOps.locationMetadata(path, stat.birthtimeMs, stat.mtimeMs);
    this.db.transaction(() => {
      //Lets check to see if this location is already in the database
      const result = fileOps.checkPathExists(this.db, path, this.options.libraryId);
      if (result) {
        //Location exists, we compare hashes
        const oldFileRecord = fileOps.getFileById(this.db, result.file_id);
        //If the old file record is null, then we have a big db error (a location without a file)
        if (!oldFileRecord) {
          throw new Error('Location without file found in database');
        }
        //we update the location's last seen time regardless to avoid reprocessing
        fileOps.updateLocationLastSeen(this.db, result.location_id);
        //if the hashes match, thats all we do
        if (oldFileRecord.file_hash !== fileHash) {
          //If the hashes don't match, then we need to:
          //1. Find or create the file entry for the new content (files are global by hash)
          const newFileId =
            fileOps.getFileByHash(this.db, fileHash)?.file_id ??
            fileOps.createFile(this.db, fileHash, size);
          //2. Point the location at the new file, remembering the old one
          fileOps.relinkLocation(this.db, result.location_id, newFileId);
          //3. Copy over this library's data from the old file to the new file (Tags, etc.)
          fileOps.migrateFileData(
            this.db,
            oldFileRecord.file_id,
            newFileId,
            this.options.libraryId,
          );
          this.scanStatus.filesMigrated++;
          this.recordEvent(this.scanStatus.migrated, { path });
        } else {
          this.scanStatus.idleFiles++;
        }
        this.scanStatus.filesScanned++;
        return;
      } else {
        //Location does not exist
        //Look for the hash in the db
        const fileRecord = fileOps.getFileByHash(this.db, fileHash);
        let fileId = fileRecord?.file_id;
        //if the file does not exist, we have to make it
        if (!fileId) {
          fileId = fileOps.createFile(this.db, fileHash, size);
          this.scanStatus.filesCreated++;
        } else if (fileOps.fileHasLocationInLibrary(this.db, fileId, this.options.libraryId)) {
          this.scanStatus.duplicateFiles++;
          this.recordEvent(this.scanStatus.duplicates, {
            path,
            siblings: fileOps.getFileLocationPathsInLibrary(
              this.db,
              fileId,
              this.options.libraryId,
            ),
          });
        } else {
          //Known content, but only in other libraries. From this library's point of view it is
          //new; counting it as a duplicate would reveal that the bytes exist elsewhere.
          this.scanStatus.filesCreated++;
        }
        //if it is made, or if it already existed, we create the location
        //and link it to the file.
        fileOps.createLocation(this.db, path, this.options.libraryId, fileId, metadata);
        this.scanStatus.filesScanned++;
      }
    })();
  }

  halt() {
    this.closePending();
    this.scanStatus.state = 'halted';
  }

  status() {
    return this.scanStatus as JobStatus;
  }
}
