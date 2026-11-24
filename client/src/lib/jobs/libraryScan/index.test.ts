import { describe, expect, it } from 'vitest';
import type { LibrarySummary } from '../../api';
import { jobCounters, jobLabel, jobSubtitle } from '../index';

const libraries: LibrarySummary[] = [
  {
    library_id: 3,
    name: 'Photos',
    root_path: '/data/photos',
    role: 'owner',
    permissions: { canRead: true, canCreateTag: true, canTagFiles: true, canManageLibrary: true },
  },
];

describe('library-scan job type', () => {
  it('registers itself with a friendly label', () => {
    expect(jobLabel('library-scan')).toBe('Library scan');
    expect(jobLabel('unknown-type')).toBe('unknown-type');
  });

  it('describes a scan with library and subfolder', () => {
    const subtitle = jobSubtitle({
      type: 'library-scan',
      options: { libraryId: 3, subpath: '2023/2023-11/Iceland' },
      statusData: null,
      libraries,
    });
    expect(subtitle).toBe('Library: Photos / Subfolder: 2023/2023-11/Iceland');
  });

  it('omits the subfolder for whole-library scans', () => {
    const subtitle = jobSubtitle({
      type: 'library-scan',
      options: { libraryId: 3 },
      statusData: null,
      libraries,
    });
    expect(subtitle).toBe('Library: Photos');
  });

  it('mentions the ignore list when patterns are set', () => {
    const subtitle = jobSubtitle({
      type: 'library-scan',
      options: { libraryId: 3, ignorePaths: ['*.tmp', 'node_modules'] },
      statusData: null,
      libraries,
    });
    expect(subtitle).toBe('Library: Photos / Ignore list: 2 patterns');
  });

  it('falls back to a placeholder name when the library is not visible', () => {
    const subtitle = jobSubtitle({
      type: 'library-scan',
      options: { libraryId: 999, subpath: 'x' },
      statusData: null,
      libraries,
    });
    expect(subtitle).toBe('Library: Unknown library / Subfolder: x');
  });

  it('maps status counters to tiles in mockup order', () => {
    const counters = jobCounters({
      type: 'library-scan',
      options: null,
      statusData: {
        state: 'running',
        filesScanned: 1284,
        filesCreated: 12,
        filesMigrated: 8,
        duplicateFiles: 3,
        idleFiles: 1261,
        missingLocations: 0,
        entriesIgnored: 5,
        entriesSkipped: 2,
      },
      libraries,
    });
    expect(counters).toEqual([
      { label: 'Files scanned', value: 1284 },
      { label: 'Files created', value: 12 },
      { label: 'Files migrated', value: 8 },
      { label: 'Duplicate files', value: 3 },
      { label: 'Idle files', value: 1261 },
      { label: 'Missing locations', value: 0 },
      { label: 'Entries ignored', value: 5 },
      { label: 'Links and special files skipped', value: 2 },
    ]);
  });

  it('shows zero counters before the job has reported any status', () => {
    const counters = jobCounters({
      type: 'library-scan',
      options: null,
      statusData: null,
      libraries,
    });
    expect(counters.every((c) => c.value === 0)).toBe(true);
  });

  it('returns nothing for unregistered types', () => {
    const ctx = { type: 'other-job', options: null, statusData: null, libraries };
    expect(jobCounters(ctx)).toEqual([]);
    expect(jobSubtitle(ctx)).toBe('');
  });
});
