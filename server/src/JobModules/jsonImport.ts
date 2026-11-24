import type { Job, JobCallbacks, JobModule, JobStatus } from '../services/jobManager.ts';
import type { Db } from '../db/index.ts';
import * as fileOps from '../db/file_operations.ts';
import * as libOps from '../db/library_operations.ts';
import * as taggingOps from '../db/tagging_operations.ts';
import { ConflictError, NotFoundError, ValidationError } from '../db/errors.ts';
import { isSafeSubpath, makeIgnoreMatcher, type ScanFs } from './libraryScan.ts';
import * as fs from 'node:fs';
import * as Path from 'node:path';

export type JsonImportPathOptions = {
  path: string; //Dot-notation path into the JSON document, e.g. "author.name"
  tagId?: number; //Non-direct mode: the existing tag that receives the values
  direct?: boolean; //Direct mode: the extracted values are tag names themselves
  tagName?: string; //Presentation only: name of tagId, for the jobs UI
};

export type JsonImportOptions = {
  libraryId: number; //Library this import is for
  ignorePaths?: string[]; //Paths/files to ignore
  subpath?: string; //Directory to scan, relative to the library root. Omit to scan the whole root.
  paths: JsonImportPathOptions[];
  createIfMissing?: boolean; //Direct mode: create unknown tags
  parentTagId?: number; //Direct + createIfMissing: parent for the created tags
  color?: string | null; //Direct + createIfMissing: color for the created tags
  parentName?: string; //Presentation only: name of parentTagId, for the jobs UI
};

const isInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

/** Splits "author.name" into ["author", "name"]; rejects empty segments. */
function parseDotPath(path: unknown): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('path must be a non-empty dot-notation string');
  }
  const trimmed = path.trim();
  if (trimmed.split('.').some((segment) => segment.trim() === '')) {
    throw new Error('path must not have empty segments');
  }
  return trimmed;
}

function parsePathOptions(raw: unknown): JsonImportPathOptions {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('each JSON path must be an object');
  }
  const { path, tagId, direct, tagName } = raw as Record<string, unknown>;
  if (tagName !== undefined && typeof tagName !== 'string') {
    throw new Error('tagName must be a string');
  }
  if (direct !== undefined && typeof direct !== 'boolean') {
    throw new Error('direct must be a boolean');
  }
  if (direct) {
    if (tagId !== undefined) {
      throw new Error('tagId must be omitted in direct mode');
    }
  } else if (!isInteger(tagId)) {
    throw new Error('tagId must be an integer in non-direct mode');
  }
  return {
    path: parseDotPath(path),
    ...(tagId !== undefined ? { tagId } : {}),
    ...(tagName !== undefined ? { tagName } : {}),
    direct,
  };
}

/** Walks `data` along dot-notation segments. Returns undefined when any segment misses. */
export function getByDotPath(data: unknown, path: string): unknown {
  let current = data;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The file part of a path without its last extension; "notes" for "a/b.md", "a" for ".env". */
function stemOf(name: string): string {
  const ext = Path.extname(name);
  return ext === '' ? name : name.slice(0, -ext.length);
}

export default class JsonImportModule implements JobModule<JsonImportOptions> {
  name = 'json-import';
  private fs: ScanFs;

  constructor({ fs: scanFs = fs }: { fs?: ScanFs } = {}) {
    this.fs = scanFs;
  }

  parseOptions(raw: unknown): JsonImportOptions {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('JSON import options must be an object');
    }
    const record = raw as Record<string, unknown>;
    const { libraryId, ignorePaths, subpath, createIfMissing } = record;
    let { color } = record;
    const { parentTagId, parentName } = record;

    if (!isInteger(libraryId)) {
      throw new Error('libraryId must be an integer');
    }
    if (parentName !== undefined && typeof parentName !== 'string') {
      throw new Error('parentName must be a string');
    }
    if (ignorePaths !== undefined && !isStringArray(ignorePaths)) {
      throw new Error('ignorePaths must be an array of strings');
    }
    if (subpath !== undefined && (typeof subpath !== 'string' || !isSafeSubpath(subpath))) {
      throw new Error('subpath must be a relative path inside the library root');
    }
    if (createIfMissing !== undefined && typeof createIfMissing !== 'boolean') {
      throw new Error('createIfMissing must be a boolean');
    }
    if (parentTagId !== undefined && !isInteger(parentTagId)) {
      throw new Error('parentTagId must be an integer');
    }
    if (color !== undefined && color !== null && typeof color !== 'string') {
      throw new Error('color must be a string or null');
    }
    if (typeof color === 'string') {
      color = color.trim() === '' ? null : color.trim();
    }

    let paths: JsonImportPathOptions[];
    if (record.paths !== undefined) {
      if (!Array.isArray(record.paths) || record.paths.length === 0) {
        throw new Error('paths must be a non-empty array');
      }
      if (['path', 'tagId', 'tagName', 'direct'].some((key) => key in record)) {
        throw new Error('single-path options cannot be combined with paths');
      }
      paths = record.paths.map(parsePathOptions);
    } else {
      paths = [parsePathOptions(record)];
    }

    const hasDirect = paths.some((path) => path.direct);
    if (!hasDirect && (createIfMissing || parentTagId !== undefined || color != null)) {
      throw new Error('createIfMissing, parentTagId, and color require direct mode');
    }
    if (!createIfMissing && (parentTagId !== undefined || color != null)) {
      throw new Error('parentTagId and color require createIfMissing');
    }

    return {
      libraryId,
      ignorePaths,
      subpath,
      paths,
      createIfMissing,
      ...(parentTagId !== undefined ? { parentTagId } : {}),
      ...(parentName !== undefined ? { parentName } : {}),
      ...(color !== undefined ? { color: color as string | null } : {}),
    };
  }

  createJob(options: JsonImportOptions, db: Db, callbacks: JobCallbacks) {
    return new JsonImportJob(options, db, callbacks, this.fs) as Job;
  }
}

type PathStats = {
  path: string;
  tagId?: number;
  tagName?: string;
  direct: boolean;
  applications: number;
  tagsCreated: number;
  misses: number;
};

type MissEvent = {
  json: string;
  path: string;
  reason: string;
};

type Counters = {
  state: string;
  message: string;
  jsonFilesFound: number; //Sidecar JSON files seen on disk
  filesTagged: number; //Distinct data files that received at least one tag
  valuesApplied: number; //Values written (non-direct) or names applied (direct)
  tagsCreated: number; //Direct + createIfMissing: brand new tags
  invalidJson: number; //Sidecars that did not parse
  skippedUnknownTargets: number; //Sibling candidates with no known location
  skippedValues: number; //Values that were objects, nested arrays, or a missing path
  missingTagNames: number; //Direct: a name that matched no tag and was not created
  createFailures: number; //Direct + createIfMissing: tag creation rejected by the db
  entriesIgnored: number; //Files/dirs skipped by the ignore list
  pathStats: PathStats[];
  misses: MissEvent[];
  imports: { json: string; targets: string[] }[];
  errors: { path: string; reason: string }[];
};

class JsonImportJob implements Job {
  private db: Db;
  private options: JsonImportOptions;
  private callbacks: JobCallbacks;
  private fs: ScanFs;

  private paths: string[];
  private libraryRecord: libOps.LibraryRecord;
  private complete: boolean;
  private isIgnored: (path: string) => boolean;
  private taggedFiles = new Set<number>();
  /** Direct-mode name → tagId cache; `null` marks a name that must not be created again. */
  private knownTagNames = new Map<string, number | null>();

  private counters: Counters = {
    state: 'running',
    message: 'running...',
    jsonFilesFound: 0,
    filesTagged: 0,
    valuesApplied: 0,
    tagsCreated: 0,
    invalidJson: 0,
    skippedUnknownTargets: 0,
    skippedValues: 0,
    missingTagNames: 0,
    createFailures: 0,
    entriesIgnored: 0,
    pathStats: [],
    misses: [],
    imports: [],
    errors: [],
  };

  constructor(options: JsonImportOptions, db: Db, callbacks: JobCallbacks, scanFs: ScanFs) {
    this.db = db;
    this.options = options;
    this.fs = scanFs;
    this.callbacks = callbacks;

    const record = libOps.getLibraryById(this.db, this.options.libraryId);
    if (!record) {
      throw new Error('Library not found');
    }
    this.libraryRecord = record;
    //Resolving these now fails job creation (400) instead of failing mid-run.
    for (const path of options.paths) {
      if (path.tagId !== undefined) {
        taggingOps.requireTagInLibrary(db, path.tagId, options.libraryId);
      }
    }
    if (options.parentTagId !== undefined) {
      taggingOps.requireTagInLibrary(db, options.parentTagId, options.libraryId);
    }

    const subpath = Path.normalize(options.subpath || '.').replace(/[\\/]+$/, '') || '.';
    this.paths = [subpath];
    this.complete = false;
    this.isIgnored = makeIgnoreMatcher(options.ignorePaths ?? []);
    this.counters.pathStats = options.paths.map((path) => ({
      path: path.path,
      ...(path.tagId !== undefined ? { tagId: path.tagId } : {}),
      ...(path.tagName !== undefined ? { tagName: path.tagName } : {}),
      direct: path.direct === true,
      applications: 0,
      tagsCreated: 0,
      misses: 0,
    }));
  }

  execute() {
    try {
      if (this.paths.length === 0) {
        if (!this.complete) {
          this.complete = true;
          this.counters.state = 'complete';
          this.counters.filesTagged = this.taggedFiles.size;
          this.callbacks.jobComplete();
        }
        return;
      }
      const path = this.paths.pop();
      if (path === undefined) return;
      if (this.isIgnored(path)) {
        this.counters.entriesIgnored++;
        this.callbacks.stepComplete();
        return;
      }
      //lstat: a symbolic link is never followed, like in the scan.
      const stat = this.fs.lstatSync(Path.join(this.libraryRecord.root_path, path));
      if (stat.isDirectory()) {
        this.expandDirectory(path);
      } else if (stat.isFile() && path.toLowerCase().endsWith('.json')) {
        this.importSidecar(path);
      }
    } catch (error) {
      console.error('Error during JSON import:', error);
      this.counters.message = 'Error during import';
      this.counters.state = 'error';
      this.callbacks.jobFailed(error);
    }
    this.callbacks.stepComplete();
  }

  private static MAX_EVENTS = 100;

  private recordEvent<T>(list: T[], event: T) {
    if (list.length < JsonImportJob.MAX_EVENTS) {
      list.push(event);
    }
  }

  private expandDirectory(path: string) {
    const newPaths = this.fs.readdirSync(Path.join(this.libraryRecord.root_path, path));
    this.paths.push(...newPaths.map((p) => Path.join(path, p)));
  }

  private absolute(rel: string): string {
    return Path.join(this.libraryRecord.root_path, rel);
  }

  /** True for a regular file. A symbolic link is not a target. */
  private isExistingFile(rel: string): boolean {
    if (!this.fs.existsSync(this.absolute(rel))) return false;
    return this.fs.lstatSync(this.absolute(rel)).isFile();
  }

  /**
   * Finds the data files a sidecar describes. Convention one: `photo.jpg.json` points at
   * `photo.jpg` and wins alone. Convention two: `photo.json` points at every non-JSON
   * sibling named `photo.<ext>`.
   */
  private sidecarTargets(jsonPath: string): string[] {
    const base = jsonPath.slice(0, -'.json'.length);
    if (Path.extname(base) !== '' && this.isExistingFile(base)) {
      return [base];
    }
    const dir = Path.dirname(jsonPath);
    const stem = Path.basename(base);
    const names = this.fs.readdirSync(this.absolute(dir));
    return names
      .filter((name) => {
        if (name.toLowerCase().endsWith('.json')) return false;
        if (Path.extname(name) === '') return false;
        if (stemOf(name) !== stem) return false;
        return this.isExistingFile(Path.join(dir, name));
      })
      .map((name) => Path.join(dir, name))
      .sort();
  }

  private importSidecar(jsonPath: string) {
    this.counters.jsonFilesFound++;
    //Filesystem errors propagate to execute() and fail the job, like the scan; only a parse
    //failure is counted and skipped.
    const text = this.fs.readFileSync(this.absolute(jsonPath)).toString('utf-8');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.counters.invalidJson++;
      this.recordEvent(this.counters.errors, { path: jsonPath, reason: 'Invalid JSON' });
      return;
    }

    const targets = this.sidecarTargets(jsonPath);
    if (targets.length === 0) {
      this.counters.skippedUnknownTargets++;
      return;
    }

    const fileIds: number[] = [];
    for (const target of targets) {
      const location = fileOps.checkPathExists(this.db, target, this.options.libraryId);
      if (!location || location.missing !== 0) {
        this.counters.skippedUnknownTargets++;
      } else {
        fileIds.push(location.file_id);
      }
    }
    if (fileIds.length === 0) return;

    let appliedAny = false;
    for (let i = 0; i < this.options.paths.length; i++) {
      const rule = this.options.paths[i]!;
      const stats = this.counters.pathStats[i]!;
      const raw = getByDotPath(data, rule.path);
      if (raw === undefined) {
        this.recordMiss(jsonPath, rule.path, stats, 'Path not found');
        continue;
      }
      const entries = Array.isArray(raw) ? raw : [raw];
      if (!entries.some((entry) => this.isUsableEntry(rule, entry))) {
        this.counters.skippedValues += entries.length;
        this.recordMiss(jsonPath, rule.path, stats, 'No usable value at path');
        continue;
      }

      this.db.transaction(() => {
        for (const fileId of fileIds) {
          if (rule.direct) {
            this.applyDirect(fileId, entries, stats);
          } else {
            this.applyTagged(fileId, entries, rule, stats);
          }
          this.taggedFiles.add(fileId);
          appliedAny = true;
        }
      })();
    }
    if (appliedAny) {
      this.recordEvent(this.counters.imports, { json: jsonPath, targets });
    }
    this.counters.filesTagged = this.taggedFiles.size;
  }

  private isUsableEntry(rule: JsonImportPathOptions, entry: unknown): boolean {
    if (rule.direct) return this.nameFromEntry(entry) !== null;
    return (
      entry === null ||
      (typeof entry === 'string' && entry !== '') ||
      (typeof entry === 'number' && Number.isFinite(entry)) ||
      typeof entry === 'boolean'
    );
  }

  private recordMiss(jsonPath: string, path: string, stats: PathStats, reason: string) {
    stats.misses++;
    this.recordEvent(this.counters.misses, { json: jsonPath, path, reason });
  }

  /** Non-direct mode: tag the file and write one value per scalar entry. */
  private applyTagged(
    fileId: number,
    entries: unknown[],
    rule: JsonImportPathOptions,
    stats: PathStats,
  ) {
    const tagId = rule.tagId as number;
    taggingOps.tagFile(this.db, fileId, tagId, this.options.libraryId);
    for (const entry of entries) {
      if (typeof entry === 'string' && entry !== '') {
        taggingOps.createTextFileValue(this.db, fileId, tagId, entry, this.options.libraryId);
        this.counters.valuesApplied++;
        stats.applications++;
      } else if (typeof entry === 'number' && Number.isFinite(entry)) {
        taggingOps.createNumberFileValue(this.db, fileId, tagId, entry, this.options.libraryId);
        this.counters.valuesApplied++;
        stats.applications++;
      } else if (typeof entry === 'boolean') {
        taggingOps.createTextFileValue(
          this.db,
          fileId,
          tagId,
          String(entry),
          this.options.libraryId,
        );
        this.counters.valuesApplied++;
        stats.applications++;
      } else if (entry === null) {
        //Null applies the tag with no value; tagFile above already did that.
      } else {
        this.counters.skippedValues++;
      }
    }
  }

  /** Direct mode: each entry is a tag name; resolve it (alias-aware), maybe create, apply. */
  private applyDirect(fileId: number, entries: unknown[], stats: PathStats) {
    for (const entry of entries) {
      const name = this.nameFromEntry(entry);
      if (name === null) {
        this.counters.skippedValues++;
        continue;
      }
      const tagId = this.tagIdForName(name, stats);
      if (tagId === null) continue;
      taggingOps.tagFile(this.db, fileId, tagId, this.options.libraryId);
      this.counters.valuesApplied++;
      stats.applications++;
    }
  }

  private nameFromEntry(entry: unknown): string | null {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      return trimmed === '' || trimmed === '*' ? null : trimmed;
    }
    if (typeof entry === 'number' && Number.isFinite(entry)) return String(entry);
    if (typeof entry === 'boolean') return String(entry);
    return null;
  }

  /** Resolves a direct-mode name to a tag id, honoring aliases and the create options.
   *  `null` means skip this name without further work. */
  private tagIdForName(name: string, stats: PathStats): number | null {
    const cached = this.knownTagNames.get(name);
    if (cached !== undefined) return cached;

    let tagId = taggingOps.searchTagByAlias(this.db, name, this.options.libraryId)?.tag_id ?? null;
    if (tagId === null && this.options.createIfMissing) {
      try {
        tagId = taggingOps.createTag(this.db, {
          alias: name,
          libraryId: this.options.libraryId,
          color: this.options.color ?? null,
          parentId: this.options.parentTagId,
        });
        this.counters.tagsCreated++;
        stats.tagsCreated++;
      } catch (error) {
        if (error instanceof ConflictError || error instanceof ValidationError) {
          this.counters.createFailures++;
          this.knownTagNames.set(name, null);
          return null;
        }
        if (error instanceof NotFoundError) {
          this.counters.createFailures++;
          this.knownTagNames.set(name, null);
          return null;
        }
        throw error;
      }
    } else if (tagId === null) {
      this.counters.missingTagNames++;
    }
    this.knownTagNames.set(name, tagId);
    return tagId;
  }

  halt() {
    this.counters.state = 'halted';
  }

  status() {
    return { ...this.counters, filesTagged: this.taggedFiles.size } as JobStatus;
  }
}
