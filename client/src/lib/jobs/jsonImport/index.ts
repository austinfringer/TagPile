import { registerJobType, type JobTypeContext } from '../registry';
import JsonImportOptions from './JsonImportOptions.svelte';
import JsonImportDetails from './JsonImportDetails.svelte';

interface JsonImportPathOptions {
  path?: unknown;
  tagName?: unknown;
  direct?: unknown;
}

interface JsonImportJobOptions extends JsonImportPathOptions {
  libraryId?: unknown;
  subpath?: unknown;
  ignorePaths?: unknown;
  paths?: unknown;
  createIfMissing?: unknown;
  parentName?: unknown;
}

const IMPORT_COUNTERS: { key: string; label: string }[] = [
  { key: 'jsonFilesFound', label: 'JSON files' },
  { key: 'filesTagged', label: 'Files tagged' },
  { key: 'valuesApplied', label: 'Values applied' },
  { key: 'tagsCreated', label: 'Tags created' },
  { key: 'invalidJson', label: 'Invalid JSON' },
  { key: 'skippedUnknownTargets', label: 'Skipped targets' },
  { key: 'skippedValues', label: 'Skipped values' },
  { key: 'missingTagNames', label: 'Missing tag names' },
  { key: 'createFailures', label: 'Create failures' },
  { key: 'entriesIgnored', label: 'Entries ignored' },
];

function libraryName(ctx: JobTypeContext, options: JsonImportJobOptions): string {
  const libraryId = typeof options.libraryId === 'number' ? options.libraryId : null;
  return ctx.libraries.find((lib) => lib.library_id === libraryId)?.name ?? 'Unknown library';
}

function pathDescription(options: JsonImportPathOptions): string {
  const path = typeof options.path === 'string' ? options.path : 'Unknown path';
  const mode =
    options.direct === true
      ? 'Direct'
      : typeof options.tagName === 'string'
        ? options.tagName
        : 'Unknown tag';
  return `${path} → ${mode}`;
}

registerJobType('json-import', {
  label: 'JSON import',
  describe(ctx) {
    const options = (ctx.options ?? {}) as JsonImportJobOptions;
    const parts = [`Library: ${libraryName(ctx, options)}`];
    if (Array.isArray(options.paths)) {
      const paths = options.paths as JsonImportPathOptions[];
      parts.push(`Paths: ${paths.map(pathDescription).join('; ')}`);
      if (options.createIfMissing === true) {
        const parent = typeof options.parentName === 'string' ? ` under ${options.parentName}` : '';
        parts.push(`Creates new tags${parent}`);
      }
    } else {
      if (typeof options.path === 'string') parts.push(`Path: ${options.path}`);
      if (options.direct === true) {
        const parent = typeof options.parentName === 'string' ? ` under ${options.parentName}` : '';
        parts.push(
          options.createIfMissing === true ? `Direct (creates new tags${parent})` : 'Direct',
        );
      } else {
        parts.push(`Tag: ${typeof options.tagName === 'string' ? options.tagName : 'Unknown tag'}`);
      }
    }
    if (typeof options.subpath === 'string') parts.push(`Subfolder: ${options.subpath}`);
    return parts.join(' / ');
  },
  counters(ctx) {
    return IMPORT_COUNTERS.map(({ key, label }) => ({
      label,
      value: typeof ctx.statusData?.[key] === 'number' ? (ctx.statusData[key] as number) : 0,
    }));
  },
  Options: JsonImportOptions,
  Details: JsonImportDetails,
});
