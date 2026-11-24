/** Shared client-side preview store. Callers declare which file ids are on screen with
 *  `ensurePreviews`; unknown ids go out to the batch endpoint in groups of MAX_BATCH and the
 *  resolved image sources land in a cache keyed by file id. Reading `previewSource` inside a
 *  `$derived` re-evaluates when the entry arrives.
 *
 *  A file with no preview (a non-image type, or anything the server could not generate) maps
 *  to `null`, not an error: every caller keeps its placeholder as the fallback. */

import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { fetchPreviews } from './api';

/** Matches the server's per-request cap for the batch preview endpoint. */
const MAX_BATCH = 500;

/** Resolved image sources by file id: a `data:` URL when the file has a preview, `null` when
 *  it has none. Absent means not yet requested or in flight. */
const cache = new SvelteMap<number, string | null>();
const pending = new SvelteSet<number>();

/** Requests previews for the ids that are neither cached nor already in flight. */
export function ensurePreviews(fileIds: number[]): void {
  const missing = fileIds.filter(
    (id, i) => fileIds.indexOf(id) === i && !cache.has(id) && !pending.has(id),
  );
  if (missing.length === 0) return;
  for (const id of missing) pending.add(id);
  void load(missing);
}

async function load(ids: number[]): Promise<void> {
  try {
    for (let i = 0; i < ids.length; i += MAX_BATCH) {
      const { previews } = await fetchPreviews(ids.slice(i, i + MAX_BATCH));
      for (const entry of previews) {
        cache.set(entry.fileId, `data:${entry.mime};base64,${entry.data}`);
      }
    }
  } catch {
    // The request failed as a whole: every requested id falls back to the placeholder.
  } finally {
    for (const id of ids) {
      pending.delete(id);
      if (!cache.has(id)) cache.set(id, null);
    }
  }
}

/** The preview image source for one file, or `null` while it loads and when the file has
 *  no preview at all. Use `ensurePreviews` to start the fetch. */
export function previewSource(fileId: number): string | null {
  return cache.get(fileId) ?? null;
}

/** Drops all cached previews (used by tests and library switches). */
export function clearPreviews(): void {
  cache.clear();
}
