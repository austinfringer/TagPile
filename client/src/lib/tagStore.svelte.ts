import { SvelteMap } from 'svelte/reactivity';
import type { TagDetail, TagSummary } from './api';

const tagsById = new SvelteMap<number, TagSummary>();
let storeLibraryId: number | null = null;

function syncLibrary(libraryId?: number | null): void {
  if (libraryId === undefined || libraryId === null) return;
  if (storeLibraryId !== null && storeLibraryId !== libraryId) {
    tagsById.clear();
  }
  storeLibraryId = libraryId;
}

/** Reactive map of known tags in the active library, keyed by `tagId`. */
export function tagStore(): ReadonlyMap<number, TagSummary> {
  return tagsById;
}

export function getTagSummary(tagId: number): TagSummary | undefined {
  return tagsById.get(tagId);
}

export function upsertTag(tag: TagSummary, libraryId?: number | null): void {
  syncLibrary(libraryId);
  tagsById.set(tag.tagId, tag);
}

export function upsertTags(
  tags: Iterable<TagSummary> | Record<number, TagSummary> | undefined | null,
  libraryId?: number | null,
): void {
  syncLibrary(libraryId);
  if (!tags) return;
  const list =
    Symbol.iterator in Object(tags) ? (tags as Iterable<TagSummary>) : Object.values(tags);
  for (const tag of list) {
    if (tag && typeof tag.tagId === 'number') {
      tagsById.set(tag.tagId, tag);
    }
  }
}

export function upsertTagDetail(
  detail: TagDetail | undefined | null,
  libraryId?: number | null,
): void {
  if (!detail) return;
  syncLibrary(libraryId ?? detail.tag?.library_id);
  if (detail.tags) {
    upsertTags(detail.tags);
  }
  for (const group of [detail.parents, detail.ancestors, detail.children, detail.descendants]) {
    for (const item of group ?? []) {
      const existing = tagsById.get(item.tagId);
      if (existing) {
        tagsById.set(item.tagId, {
          ...existing,
          name: item.name ?? existing.name,
          color: item.color,
        });
      } else if (item.name !== null) {
        tagsById.set(item.tagId, {
          tagId: item.tagId,
          name: item.name,
          color: item.color,
          isCategory: false,
          fileCount: 0,
          parentName: null,
        });
      }
    }
  }
  if (detail.tag && typeof detail.tag.tag_id === 'number') {
    const tagId = detail.tag.tag_id;
    const existing = tagsById.get(tagId);
    const primary = detail.aliases?.find((a) => a.is_primary === 1) ?? detail.aliases?.[0];
    const name = primary?.text ?? existing?.name ?? `#${tagId}`;
    let parentName = existing?.parentName ?? null;
    if (detail.parents && detail.parents.length > 0) {
      parentName = detail.parents[0]?.name ?? parentName;
    } else if (detail.instances) {
      const primaryParent = detail.instances.find((i) =>
        i.values?.some((v) => v.kind === 'parent' && v.primary),
      );
      const anyParent =
        primaryParent ?? detail.instances.find((i) => i.values?.some((v) => v.kind === 'parent'));
      if (anyParent) {
        parentName = anyParent.name ?? tagsById.get(anyParent.tagId)?.name ?? null;
      }
    }
    tagsById.set(tagId, {
      tagId,
      name,
      color: detail.tag.color !== undefined ? detail.tag.color : (existing?.color ?? null),
      isCategory:
        detail.tag.is_category !== undefined
          ? detail.tag.is_category === 1
          : (existing?.isCategory ?? false),
      fileCount: detail.tag.file_count ?? existing?.fileCount ?? 0,
      parentName,
    });
  }
}

export function removeTagFromStore(tagId: number): void {
  tagsById.delete(tagId);
}

export function clearTagStore(): void {
  tagsById.clear();
  storeLibraryId = null;
}
