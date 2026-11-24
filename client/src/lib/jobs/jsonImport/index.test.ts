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

describe('json-import job type', () => {
  it('registers itself with a friendly label', () => {
    expect(jobLabel('json-import')).toBe('JSON import');
  });

  it('describes a non-direct import with library, path, and tag', () => {
    const subtitle = jobSubtitle({
      type: 'json-import',
      options: { libraryId: 3, path: 'author.name', tagId: 7, tagName: 'Author' },
      statusData: null,
      libraries,
    });
    expect(subtitle).toBe('Library: Photos / Path: author.name / Tag: Author');
  });

  it('describes a direct import, mentioning creation and the parent', () => {
    const subtitle = jobSubtitle({
      type: 'json-import',
      options: {
        libraryId: 3,
        path: 'people',
        direct: true,
        createIfMissing: true,
        parentTagId: 9,
        parentName: 'People',
        subpath: '2023',
      },
      statusData: null,
      libraries,
    });
    expect(subtitle).toBe(
      'Library: Photos / Path: people / Direct (creates new tags under People) / Subfolder: 2023',
    );
  });

  it('describes multiple paths and shared tag creation settings', () => {
    const subtitle = jobSubtitle({
      type: 'json-import',
      options: {
        libraryId: 3,
        paths: [
          { path: 'author.name', tagId: 7, tagName: 'Author' },
          { path: 'people', direct: true },
        ],
        createIfMissing: true,
        parentName: 'People',
      },
      statusData: null,
      libraries,
    });
    expect(subtitle).toBe(
      'Library: Photos / Paths: author.name → Author; people → Direct / Creates new tags under People',
    );
  });

  it('falls back to placeholders for unknown names', () => {
    const subtitle = jobSubtitle({
      type: 'json-import',
      options: { libraryId: 999, path: 'a', tagId: 1 },
      statusData: null,
      libraries,
    });
    expect(subtitle).toBe('Library: Unknown library / Path: a / Tag: Unknown tag');
  });

  it('maps status counters to tiles', () => {
    const counters = jobCounters({
      type: 'json-import',
      options: null,
      statusData: {
        state: 'running',
        jsonFilesFound: 10,
        filesTagged: 8,
        valuesApplied: 15,
        tagsCreated: 2,
        invalidJson: 1,
        skippedUnknownTargets: 1,
        skippedValues: 3,
        missingTagNames: 4,
        createFailures: 0,
        entriesIgnored: 0,
      },
      libraries,
    });
    expect(counters).toEqual([
      { label: 'JSON files', value: 10 },
      { label: 'Files tagged', value: 8 },
      { label: 'Values applied', value: 15 },
      { label: 'Tags created', value: 2 },
      { label: 'Invalid JSON', value: 1 },
      { label: 'Skipped targets', value: 1 },
      { label: 'Skipped values', value: 3 },
      { label: 'Missing tag names', value: 4 },
      { label: 'Create failures', value: 0 },
      { label: 'Entries ignored', value: 0 },
    ]);
  });

  it('shows zero counters before the job has reported any status', () => {
    const counters = jobCounters({
      type: 'json-import',
      options: null,
      statusData: null,
      libraries,
    });
    expect(counters).toHaveLength(10);
    expect(counters.every((c) => c.value === 0)).toBe(true);
  });
});
