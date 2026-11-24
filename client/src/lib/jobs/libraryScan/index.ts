import { registerJobType, type JobTypeContext } from '../registry';
import LibraryScanOptions from './LibraryScanOptions.svelte';
import LibraryScanDetails from './LibraryScanDetails.svelte';

interface LibraryScanJobOptions {
  libraryId?: unknown;
  subpath?: unknown;
  ignorePaths?: unknown;
}

const SCAN_COUNTERS: { key: string; label: string }[] = [
  { key: 'filesScanned', label: 'Files scanned' },
  { key: 'filesCreated', label: 'Files created' },
  { key: 'filesMigrated', label: 'Files migrated' },
  { key: 'duplicateFiles', label: 'Duplicate files' },
  { key: 'idleFiles', label: 'Idle files' },
  { key: 'missingLocations', label: 'Missing locations' },
  { key: 'entriesIgnored', label: 'Entries ignored' },
  { key: 'entriesSkipped', label: 'Links and special files skipped' },
];

function libraryName(ctx: JobTypeContext, options: LibraryScanJobOptions): string {
  const libraryId = typeof options.libraryId === 'number' ? options.libraryId : null;
  return ctx.libraries.find((lib) => lib.library_id === libraryId)?.name ?? 'Unknown library';
}

registerJobType('library-scan', {
  label: 'Library scan',
  describe(ctx) {
    const options = (ctx.options ?? {}) as LibraryScanJobOptions;
    const name = libraryName(ctx, options);
    const subpath = typeof options.subpath === 'string' ? options.subpath : null;
    const ignored = Array.isArray(options.ignorePaths) ? options.ignorePaths.length : 0;
    const parts = [`Library: ${name}`];
    if (subpath) parts.push(`Subfolder: ${subpath}`);
    if (ignored > 0) parts.push(`Ignore list: ${ignored} patterns`);
    return parts.join(' / ');
  },
  counters(ctx) {
    return SCAN_COUNTERS.map(({ key, label }) => ({
      label,
      value: typeof ctx.statusData?.[key] === 'number' ? (ctx.statusData[key] as number) : 0,
    }));
  },
  Options: LibraryScanOptions,
  Details: LibraryScanDetails,
});
