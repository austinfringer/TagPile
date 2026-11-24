<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import Button from '../lib/Button.svelte';
  import TagChip from '../lib/TagChip.svelte';
  import {
    addAlias,
    addTagValue,
    autocompleteQuery,
    deleteAlias,
    deleteTagValue,
    fetchTag,
    listTags,
    removeTagComponent,
    removeTagParent,
    setTagComponent,
    setTagParent,
    tagTag,
    untagTag,
    updateAlias,
    updateTag,
    updateTagValue,
    type Alias,
    type TagDetail,
    type TagHierarchyItem,
    type TagInstance,
    type TagSummary,
    type TagValue,
  } from '../lib/api';
  import {
    notifyRelationshipChanged,
    relationshipStamp,
    resolveLibraryId,
  } from '../lib/contextmenu/contextmenu.svelte';
  import { goBack, navigate } from '../lib/router.svelte';
  import { tagStore, upsertTag, upsertTagDetail } from '../lib/tagStore.svelte';
  import { DEFAULT_TAG_COLOR } from '../lib/tagColors';
  import TagAutocompleteInput, { type SelectedTag } from '../lib/tag/TagAutocompleteInput.svelte';
  import {
    applyWikiLinkCompletion,
    buildWikiTagLookup,
    findActiveWikiLink,
    getTextareaCaretRect,
    parseWikiMarkdown,
    type WikiInline,
  } from '../lib/tag/wiki';

  const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;

  function parseNumberInput(raw: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed || !NUMBER_RE.test(trimmed)) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  }

  type NewValueKind = 'parent' | 'component' | 'text' | 'number' | 'tag' | 'none';

  interface EditableAliasRow {
    aliasId: number;
    originalText: string;
    textDraft: string;
    isPrimary: boolean;
    isShorthand: boolean;
    busy: boolean;
    rowError: string | null;
  }

  interface EditableTagValueRow {
    valueId: number;
    instanceTagId: number;
    kind: TagValue['kind'];
    original: TagValue;
    textDraft: string;
    numberDraft: string;
    selectedTag: SelectedTag | null;
    primary: boolean;
    recursive: boolean;
    attributed: boolean;
    busy: boolean;
    rowError: string | null;
  }

  interface EditableRelationship {
    tagId: number;
    name: string;
    color: string | null;
    rows: EditableTagValueRow[];
    busy: boolean;
    error: string | null;
  }

  interface WikiTagSuggestion {
    tagId: number;
    aliasText: string;
    primaryName: string;
    color: string | null;
    parentName: string | null;
    fileCount: number;
  }

  let {
    id,
    libraryId = null,
    debounceMs = 150,
  }: {
    id: string | number;
    libraryId?: number | null;
    debounceMs?: number;
  } = $props();

  const tagId = $derived(typeof id === 'number' ? id : Number(id));

  let resolvedLibraryId = $state<number | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let primaryName = $state('');
  let fileCount = $state(0);
  let colorDraft = $state(DEFAULT_TAG_COLOR);
  let isCategory = $state(false);
  let settingsBusy = $state(false);
  let settingsError = $state<string | null>(null);

  // ---- Wiki state -----------------------------------------------------------

  let wikiText = $state('');
  let wikiDraft = $state('');
  let editingWiki = $state(false);
  let savingWiki = $state(false);
  let wikiError = $state<string | null>(null);
  let wikiTextarea = $state<HTMLTextAreaElement | null>(null);
  let wikiCursor = $state(0);
  let wikiSuggestions = $state<WikiTagSuggestion[]>([]);
  let wikiActiveIndex = $state(0);
  let wikiDismissedQuery = $state<string | null>(null);
  /** Dropdown anchor in px, relative to the editor wrap; null falls back to the bottom. */
  let wikiAnchor = $state<{ top: number; left: number } | null>(null);

  // ---- Hierarchy sidebar state ----------------------------------------------

  let parents = $state<TagHierarchyItem[]>([]);
  let ancestors = $state<TagHierarchyItem[]>([]);
  let children = $state<TagHierarchyItem[]>([]);
  let descendants = $state<TagHierarchyItem[]>([]);

  // ---- Aliases & Relationships state ----------------------------------------

  let aliasRows = $state<EditableAliasRow[]>([]);
  let newAliasText = $state('');
  let addingAlias = $state(false);
  let aliasError = $state<string | null>(null);

  let relationships = $state<EditableRelationship[]>([]);

  let newRelatedTag = $state<SelectedTag | null>(null);
  let newValueKind = $state<NewValueKind>('parent');
  let newParentPrimary = $state(false);
  let newComponentRecursive = $state(false);
  let newComponentAttributed = $state(true);
  let newTextValue = $state('');
  let newNumberText = $state('');
  let newRefTag = $state<SelectedTag | null>(null);
  let addingValue = $state(false);
  let addValueError = $state<string | null>(null);

  const tagsById = tagStore();
  let currentAliases = $state<Alias[]>([]);

  function toAliasRow(alias: Alias): EditableAliasRow {
    return {
      aliasId: alias.alias_id,
      originalText: alias.text,
      textDraft: alias.text,
      isPrimary: alias.is_primary === 1,
      isShorthand: alias.is_shorthand === 1,
      busy: false,
      rowError: null,
    };
  }

  function tagChipInfo(targetTagId: number, fallbackName?: string | null): SelectedTag {
    const info = tagsById.get(targetTagId);
    return {
      tagId: targetTagId,
      name: info?.name ?? fallbackName ?? `#${targetTagId}`,
      color: info?.color ?? null,
    };
  }

  function toValueRow(
    instanceTagId: number,
    instanceName: string | null,
    value: TagValue,
  ): EditableTagValueRow {
    if (value.kind === 'text') {
      return {
        valueId: value.valueId,
        instanceTagId,
        kind: 'text',
        original: value,
        textDraft: value.text,
        numberDraft: '',
        selectedTag: null,
        primary: false,
        recursive: false,
        attributed: true,
        busy: false,
        rowError: null,
      };
    }
    if (value.kind === 'number') {
      return {
        valueId: value.valueId,
        instanceTagId,
        kind: 'number',
        original: value,
        textDraft: '',
        numberDraft: String(value.number),
        selectedTag: null,
        primary: false,
        recursive: false,
        attributed: true,
        busy: false,
        rowError: null,
      };
    }
    if (value.kind === 'tag') {
      return {
        valueId: value.valueId,
        instanceTagId,
        kind: 'tag',
        original: value,
        textDraft: '',
        numberDraft: '',
        selectedTag: tagChipInfo(value.refTagId),
        primary: false,
        recursive: false,
        attributed: true,
        busy: false,
        rowError: null,
      };
    }
    if (value.kind === 'parent') {
      return {
        valueId: value.valueId,
        instanceTagId,
        kind: 'parent',
        original: value,
        textDraft: '',
        numberDraft: '',
        selectedTag: tagChipInfo(instanceTagId, instanceName),
        primary: value.primary,
        recursive: false,
        attributed: true,
        busy: false,
        rowError: null,
      };
    }
    return {
      valueId: value.valueId,
      instanceTagId,
      kind: 'component',
      original: value,
      textDraft: '',
      numberDraft: '',
      selectedTag: tagChipInfo(instanceTagId, instanceName),
      primary: false,
      recursive: value.recursive,
      attributed: value.attributed,
      busy: false,
      rowError: null,
    };
  }

  function toRelationship(inst: TagInstance): EditableRelationship {
    const info = tagsById.get(inst.tagId);
    return {
      tagId: inst.tagId,
      name: inst.name ?? info?.name ?? `#${inst.tagId}`,
      color: info?.color ?? null,
      rows: inst.values.map((v) => toValueRow(inst.tagId, inst.name, v)),
      busy: false,
      error: null,
    };
  }

  function deriveParentsFromInstances(instances: TagInstance[]): TagHierarchyItem[] {
    const items: TagHierarchyItem[] = [];
    for (const inst of instances) {
      if (inst.values.some((v) => v.kind === 'parent')) {
        const info = tagsById.get(inst.tagId);
        items.push({
          tagId: inst.tagId,
          name: inst.name ?? info?.name ?? `#${inst.tagId}`,
          color: info?.color ?? null,
        });
      }
    }
    return items;
  }

  function applyDetail(detail: TagDetail) {
    upsertTagDetail(detail, resolvedLibraryId);
    const primary = detail.aliases.find((a) => a.is_primary === 1) ?? detail.aliases[0];
    primaryName = primary?.text ?? `#${detail.tag.tag_id}`;
    fileCount = detail.tag.file_count;
    colorDraft = detail.tag.color ?? DEFAULT_TAG_COLOR;
    isCategory = detail.tag.is_category === 1;
    wikiText = detail.tag.wiki_text ?? '';
    if (!editingWiki) {
      wikiDraft = wikiText;
    }
    currentAliases = detail.aliases;
    aliasRows = detail.aliases.map(toAliasRow);
    relationships = detail.instances.map(toRelationship);
    parents = detail.parents ?? deriveParentsFromInstances(detail.instances);
    children = detail.children ?? [];
    const parentIds = new Set(parents.map((item) => item.tagId));
    const childIds = new Set(children.map((item) => item.tagId));
    ancestors = (detail.ancestors ?? parents).filter((item) => !parentIds.has(item.tagId));
    descendants = (detail.descendants ?? children).filter((item) => !childIds.has(item.tagId));

    upsertTag(
      {
        tagId: detail.tag.tag_id,
        name: primaryName,
        color: detail.tag.color,
        isCategory,
        fileCount: detail.tag.file_count,
        parentName: parents[0]?.name ?? null,
      },
      resolvedLibraryId,
    );
  }

  async function reloadTag(libId: number) {
    const [detail] = await Promise.all([
      fetchTag(libId, tagId),
      listTags(libId, '', { limit: 500 }).catch(() => ({ total: 0, tags: [] as TagSummary[] })),
    ]);
    applyDetail(detail);
  }

  let lastSeenStamp = 0;

  $effect(() => {
    const explicit = libraryId;
    const tId = tagId;
    const stamp = relationshipStamp();
    if (!Number.isInteger(tId) || tId <= 0) {
      loading = false;
      loadError = 'Invalid tag ID';
      return;
    }
    let cancelled = false;
    if (stamp === lastSeenStamp) {
      loading = true;
      loadError = null;
    }
    lastSeenStamp = stamp;

    (async () => {
      try {
        const libId = await resolveLibraryId(explicit);
        if (cancelled) return;
        resolvedLibraryId = libId;
        const [detail] = await Promise.all([
          fetchTag(libId, tId),
          listTags(libId, '', { limit: 500 }).catch(() => ({ total: 0, tags: [] as TagSummary[] })),
        ]);
        if (cancelled) return;
        applyDetail(detail);
      } catch (e) {
        if (!cancelled) loadError = e instanceof Error ? e.message : String(e);
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  // ---- Wiki parsing & autocomplete ------------------------------------------

  const wikiLookup = $derived.by(() => {
    const extraAliases = currentAliases.map((a) => ({ tagId: a.tag_id, text: a.text }));
    return buildWikiTagLookup(tagsById.values(), extraAliases);
  });

  const wikiBlocks = $derived(parseWikiMarkdown(wikiText, wikiLookup));

  const activeWikiLink = $derived(editingWiki ? findActiveWikiLink(wikiDraft, wikiCursor) : null);

  const wikiAutocompleteOpen = $derived(activeWikiLink !== null && wikiSuggestions.length > 0);

  let wikiSuggestRequest = 0;

  $effect(() => {
    const lib = resolvedLibraryId;
    const link = activeWikiLink;
    if (lib === null || link === null || link.query === wikiDismissedQuery) {
      wikiSuggestions = [];
      return;
    }
    const q = link.query.trim();
    const timer = setTimeout(() => {
      const reqId = ++wikiSuggestRequest;
      Promise.all([
        listTags(lib, q, { limit: 10 }),
        q ? autocompleteQuery(lib, q, 10).catch(() => null) : Promise.resolve(null),
      ])
        .then(([tagRes, autoRes]) => {
          if (reqId !== wikiSuggestRequest) return;

          const matchedAliasByTagId = new SvelteMap<number, string>();
          for (const comp of autoRes?.completions ?? []) {
            if (comp.kind === 'tag' && comp.tagId !== undefined) {
              const unquoted = comp.text.replace(/^"(.*)"$/, '$1').replace(/\\(["\\])/g, '$1');
              matchedAliasByTagId.set(comp.tagId, unquoted);
            }
          }

          const items: WikiTagSuggestion[] = tagRes.tags.map((t) => ({
            tagId: t.tagId,
            aliasText: matchedAliasByTagId.get(t.tagId) ?? t.name,
            primaryName: t.name,
            color: t.color,
            parentName: t.parentName,
            fileCount: t.fileCount,
          }));
          wikiSuggestions = items;
          wikiActiveIndex = 0;
        })
        .catch(() => {
          // Autocomplete is best-effort.
        });
    }, debounceMs);

    return () => clearTimeout(timer);
  });

  function startEditWiki() {
    wikiDraft = wikiText;
    wikiError = null;
    wikiDismissedQuery = null;
    editingWiki = true;
    void tick().then(() => {
      wikiTextarea?.focus();
      wikiCursor = wikiTextarea?.selectionStart ?? wikiDraft.length;
    });
  }

  function cancelEditWiki() {
    editingWiki = false;
    wikiDraft = wikiText;
    wikiError = null;
    wikiSuggestions = [];
  }

  async function saveWiki() {
    if (savingWiki) return;
    savingWiki = true;
    wikiError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      const detail = await updateTag(libId, tagId, { wikiText: wikiDraft });
      editingWiki = false;
      wikiSuggestions = [];
      applyDetail(detail);
    } catch (e) {
      wikiError = e instanceof Error ? e.message : String(e);
    } finally {
      savingWiki = false;
    }
  }

  function updateWikiCursor() {
    wikiCursor = wikiTextarea?.selectionStart ?? wikiDraft.length;
    if (activeWikiLink?.query !== wikiDismissedQuery) {
      wikiDismissedQuery = null;
    }
  }

  // The suggestion list floats under the line the caret is on, not under the textarea.
  const WIKI_SUGGESTION_WIDTH = 320;

  function positionWikiSuggestions() {
    const textarea = wikiTextarea;
    const rect = textarea ? getTextareaCaretRect(textarea, wikiCursor) : null;
    if (!textarea || !rect) {
      wikiAnchor = null;
      return;
    }
    const top = textarea.offsetTop + rect.top - textarea.scrollTop + rect.height + 2;
    const left = textarea.offsetLeft + rect.left - textarea.scrollLeft;
    const maxLeft = Math.max(textarea.offsetLeft + textarea.clientWidth - WIKI_SUGGESTION_WIDTH, 0);
    wikiAnchor = {
      top: Math.max(top, 0),
      left: Math.min(Math.max(left, 0), maxLeft),
    };
  }

  $effect(() => {
    if (!wikiAutocompleteOpen) {
      wikiAnchor = null;
      return;
    }
    positionWikiSuggestions();
  });

  function pickWikiSuggestion(suggestion: WikiTagSuggestion) {
    const link = activeWikiLink;
    if (!link) return;
    const applied = applyWikiLinkCompletion(
      wikiDraft,
      link,
      suggestion.tagId,
      suggestion.aliasText,
    );
    wikiDraft = applied.text;
    wikiCursor = applied.cursor;
    wikiSuggestions = [];
    wikiDismissedQuery = null;
    void tick().then(() => {
      wikiTextarea?.focus();
      wikiTextarea?.setSelectionRange(applied.cursor, applied.cursor);
    });
  }

  function onWikiKeydown(event: KeyboardEvent) {
    if (!wikiAutocompleteOpen) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      wikiActiveIndex = (wikiActiveIndex + 1) % wikiSuggestions.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      wikiActiveIndex = (wikiActiveIndex - 1 + wikiSuggestions.length) % wikiSuggestions.length;
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      pickWikiSuggestion(wikiSuggestions[wikiActiveIndex]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      wikiDismissedQuery = activeWikiLink?.query ?? null;
      wikiSuggestions = [];
    }
  }

  // ---- Tag settings (color & category) --------------------------------------

  async function saveColor(nextColor: string) {
    if (settingsBusy) return;
    colorDraft = nextColor;
    settingsBusy = true;
    settingsError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      const detail = await updateTag(libId, tagId, { color: nextColor });
      applyDetail(detail);
      notifyRelationshipChanged();
    } catch (e) {
      settingsError = e instanceof Error ? e.message : String(e);
    } finally {
      settingsBusy = false;
    }
  }

  async function toggleCategory(next: boolean) {
    if (settingsBusy) return;
    settingsBusy = true;
    settingsError = null;
    const prev = isCategory;
    isCategory = next;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      const detail = await updateTag(libId, tagId, { isCategory: next });
      applyDetail(detail);
      notifyRelationshipChanged();
    } catch (e) {
      isCategory = prev;
      settingsError = e instanceof Error ? e.message : String(e);
    } finally {
      settingsBusy = false;
    }
  }

  // ---- Aliases --------------------------------------------------------------

  const canAddAlias = $derived(!addingAlias && newAliasText.trim().length > 0);

  async function createNewAlias() {
    if (!canAddAlias) return;
    addingAlias = true;
    aliasError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      const detail = await addAlias(libId, tagId, newAliasText.trim());
      newAliasText = '';
      applyDetail(detail);
      notifyRelationshipChanged();
    } catch (e) {
      aliasError = e instanceof Error ? e.message : String(e);
    } finally {
      addingAlias = false;
    }
  }

  function canSaveAlias(row: EditableAliasRow): boolean {
    if (row.busy) return false;
    const trimmed = row.textDraft.trim();
    return trimmed.length > 0 && trimmed !== row.originalText;
  }

  async function saveAliasText(row: EditableAliasRow) {
    if (!canSaveAlias(row)) return;
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      const detail = await updateAlias(libId, tagId, row.aliasId, {
        text: row.textDraft.trim(),
      });
      applyDetail(detail);
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
      row.busy = false;
    }
  }

  async function toggleAliasPrimary(row: EditableAliasRow, checked: boolean) {
    if (row.busy) return;
    if (!checked) {
      const other = aliasRows.find((a) => a.aliasId !== row.aliasId);
      if (!other) {
        row.isPrimary = true;
        return;
      }
      row.busy = true;
      row.rowError = null;
      try {
        const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
        const detail = await updateAlias(libId, tagId, other.aliasId, {
          primary: true,
          shorthand: false,
        });
        applyDetail(detail);
        notifyRelationshipChanged();
      } catch (e) {
        row.rowError = e instanceof Error ? e.message : String(e);
        row.busy = false;
      }
      return;
    }
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      const detail = await updateAlias(libId, tagId, row.aliasId, {
        primary: true,
        shorthand: false,
      });
      applyDetail(detail);
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
      row.busy = false;
    }
  }

  async function toggleAliasShorthand(row: EditableAliasRow, checked: boolean) {
    if (row.busy) return;
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      const detail = await updateAlias(
        libId,
        tagId,
        row.aliasId,
        checked ? { shorthand: true, primary: false } : { shorthand: false },
      );
      applyDetail(detail);
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
      row.busy = false;
    }
  }

  async function removeAliasRow(row: EditableAliasRow) {
    if (row.busy || aliasRows.length <= 1) return;
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      await deleteAlias(libId, tagId, row.aliasId);
      await reloadTag(libId);
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
      row.busy = false;
    }
  }

  // ---- Relationships & values -----------------------------------------------

  function isNumberInvalid(row: EditableTagValueRow): boolean {
    return (
      row.kind === 'number' &&
      row.numberDraft.trim() !== '' &&
      parseNumberInput(row.numberDraft) === null
    );
  }

  function canSaveValueRow(row: EditableTagValueRow): boolean {
    if (row.busy) return false;
    if (row.kind === 'text') {
      const trimmed = row.textDraft.trim();
      return trimmed.length > 0 && row.original.kind === 'text' && trimmed !== row.original.text;
    }
    if (row.kind === 'number') {
      const parsed = parseNumberInput(row.numberDraft);
      return parsed !== null && row.original.kind === 'number' && parsed !== row.original.number;
    }
    return false;
  }

  async function saveValueRow(row: EditableTagValueRow) {
    if (!canSaveValueRow(row)) return;
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      if (row.kind === 'text') {
        const updated = await updateTagValue(libId, tagId, row.valueId, {
          kind: 'text',
          text: row.textDraft.trim(),
        });
        row.original = updated;
        if (updated.kind === 'text') row.textDraft = updated.text;
      } else if (row.kind === 'number') {
        const parsed = parseNumberInput(row.numberDraft)!;
        const updated = await updateTagValue(libId, tagId, row.valueId, {
          kind: 'number',
          number: parsed,
        });
        row.original = updated;
        if (updated.kind === 'number') row.numberDraft = String(updated.number);
      }
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
    } finally {
      row.busy = false;
    }
  }

  async function saveTagValueRow(row: EditableTagValueRow, picked: SelectedTag) {
    if (row.original.kind === 'tag' && picked.tagId === row.original.refTagId) return;
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      const updated = await updateTagValue(libId, tagId, row.valueId, {
        kind: 'tag',
        refTagId: picked.tagId,
      });
      row.original = updated;
      row.selectedTag = picked;
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
    } finally {
      row.busy = false;
    }
  }

  async function replaceStructuralTag(row: EditableTagValueRow, picked: SelectedTag) {
    if (picked.tagId === row.instanceTagId) return;
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      if (row.kind === 'parent') {
        await setTagParent(libId, tagId, picked.tagId, { primary: row.primary });
        await removeTagParent(libId, tagId, row.instanceTagId);
      } else if (row.kind === 'component') {
        await setTagComponent(libId, tagId, picked.tagId, {
          recursive: row.recursive,
          attributed: row.attributed,
        });
        await removeTagComponent(libId, tagId, row.instanceTagId);
      }
      await reloadTag(libId);
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
      row.busy = false;
    }
  }

  async function toggleParentPrimary(row: EditableTagValueRow, next: boolean) {
    if (row.busy) return;
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      await setTagParent(libId, tagId, row.instanceTagId, { primary: next });
      await reloadTag(libId);
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
      row.busy = false;
    }
  }

  async function toggleComponentFlags(
    row: EditableTagValueRow,
    recursive: boolean,
    attributed: boolean,
  ) {
    if (row.busy) return;
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      await setTagComponent(libId, tagId, row.instanceTagId, { recursive, attributed });
      row.recursive = recursive;
      row.attributed = attributed;
      row.original = { valueId: row.valueId, kind: 'component', recursive, attributed };
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
    } finally {
      row.busy = false;
    }
  }

  async function removeValueRow(row: EditableTagValueRow) {
    if (row.busy) return;
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      await deleteTagValue(libId, tagId, row.valueId);
      await reloadTag(libId);
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
      row.busy = false;
    }
  }

  async function removeRelationship(rel: EditableRelationship) {
    if (rel.busy) return;
    rel.busy = true;
    rel.error = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      await untagTag(libId, tagId, rel.tagId);
      await reloadTag(libId);
      notifyRelationshipChanged();
    } catch (e) {
      rel.error = e instanceof Error ? e.message : String(e);
      rel.busy = false;
    }
  }

  const parsedNewNumber = $derived(parseNumberInput(newNumberText));
  const newNumberInvalid = $derived(
    newValueKind === 'number' && newNumberText.trim() !== '' && parsedNewNumber === null,
  );

  const canAddValue = $derived.by(() => {
    if (addingValue || newRelatedTag === null) return false;
    if (newValueKind === 'parent' || newValueKind === 'component' || newValueKind === 'none') {
      return true;
    }
    if (newValueKind === 'text') return newTextValue.trim().length > 0;
    if (newValueKind === 'number') return parsedNewNumber !== null;
    if (newValueKind === 'tag') return newRefTag !== null;
    return false;
  });

  async function createNewValue() {
    if (!canAddValue || !newRelatedTag) return;
    addingValue = true;
    addValueError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      const targetId = newRelatedTag.tagId;
      upsertTag(
        {
          tagId: targetId,
          name: newRelatedTag.name,
          color: newRelatedTag.color,
          isCategory: tagsById.get(targetId)?.isCategory ?? false,
          fileCount: tagsById.get(targetId)?.fileCount ?? 0,
          parentName: tagsById.get(targetId)?.parentName ?? null,
        },
        libId,
      );

      if (newValueKind === 'parent') {
        await setTagParent(libId, tagId, targetId, { primary: newParentPrimary });
      } else if (newValueKind === 'component') {
        await setTagComponent(libId, tagId, targetId, {
          recursive: newComponentRecursive,
          attributed: newComponentAttributed,
        });
      } else if (newValueKind === 'text') {
        await addTagValue(libId, tagId, targetId, {
          kind: 'text',
          text: newTextValue.trim(),
        });
      } else if (newValueKind === 'number') {
        await addTagValue(libId, tagId, targetId, {
          kind: 'number',
          number: parsedNewNumber!,
        });
      } else if (newValueKind === 'tag' && newRefTag) {
        upsertTag(
          {
            tagId: newRefTag.tagId,
            name: newRefTag.name,
            color: newRefTag.color,
            isCategory: tagsById.get(newRefTag.tagId)?.isCategory ?? false,
            fileCount: tagsById.get(newRefTag.tagId)?.fileCount ?? 0,
            parentName: tagsById.get(newRefTag.tagId)?.parentName ?? null,
          },
          libId,
        );
        await addTagValue(libId, tagId, targetId, {
          kind: 'tag',
          refTagId: newRefTag.tagId,
        });
      } else if (newValueKind === 'none') {
        await tagTag(libId, tagId, targetId);
      }

      newRelatedTag = null;
      newParentPrimary = false;
      newComponentRecursive = false;
      newComponentAttributed = true;
      newTextValue = '';
      newNumberText = '';
      newRefTag = null;

      await reloadTag(libId);
      notifyRelationshipChanged();
    } catch (e) {
      addValueError = e instanceof Error ? e.message : String(e);
    } finally {
      addingValue = false;
    }
  }

  function selectRelationshipForAdd(rel: EditableRelationship) {
    newRelatedTag = { tagId: rel.tagId, name: rel.name, color: rel.color };
    addValueError = null;
  }

  function kindLabel(kind: TagValue['kind']): string {
    if (kind === 'parent') return 'Parent';
    if (kind === 'component') return 'Component';
    if (kind === 'text') return 'Text';
    if (kind === 'number') return 'Number';
    return 'Tag';
  }

  function onAliasKeydown(event: KeyboardEvent, row: EditableAliasRow) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveAliasText(row);
    }
  }

  function onNewAliasKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void createNewAlias();
    }
  }

  function onValueKeydown(event: KeyboardEvent, row: EditableTagValueRow) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveValueRow(row);
    }
  }
</script>

{#snippet renderInlines(inlines: WikiInline[])}
  {#each inlines as node, i (i)}
    {#if node.type === 'text'}
      {node.text}
    {:else if node.type === 'br'}
      <br />
    {:else if node.type === 'strong'}
      <strong>{@render renderInlines(node.children)}</strong>
    {:else if node.type === 'em'}
      <em>{@render renderInlines(node.children)}</em>
    {:else if node.type === 'del'}
      <del>{@render renderInlines(node.children)}</del>
    {:else if node.type === 'code'}
      <code>{node.code}</code>
    {:else if node.type === 'link'}
      <a href={node.href} target="_blank" rel="noopener noreferrer">
        {@render renderInlines(node.label)}
      </a>
    {:else if node.type === 'tag_link'}
      {#if node.tagId !== null}
        {@const targetId = node.tagId}
        <span class="inline-chip">
          <TagChip
            name={node.label}
            color={node.color}
            tagId={targetId}
            onclick={() => navigate(`/tags/${targetId}`)}
          />
        </span>
      {:else}
        <span class="wiki-unresolved">[[{node.label}]]</span>
      {/if}
    {/if}
  {/each}
{/snippet}

{#snippet renderHierarchyGroup(title: string, items: TagHierarchyItem[])}
  <section class="sidebar-group" aria-label={title}>
    <h3>{title}</h3>
    {#if items.length === 0}
      <p class="empty-group">None</p>
    {:else}
      <div class="chip-wrap">
        {#each items as item (item.tagId)}
          <TagChip
            name={item.name ?? `#${item.tagId}`}
            color={item.color}
            tagId={item.tagId}
            onclick={() => navigate(`/tags/${item.tagId}`)}
          />
        {/each}
      </div>
    {/if}
  </section>
{/snippet}

<div class="tag-detail-page">
  {#if loading}
    <p class="placeholder">Loading tag…</p>
  {:else if loadError}
    <p class="error">{loadError}</p>
  {:else}
    <div class="main-column">
      <nav class="breadcrumb">
        <button type="button" onclick={() => goBack('/tags')}>← Back</button>
      </nav>

      <header class="tag-header">
        <div class="title-block">
          <div class="title-row">
            <h1>{primaryName}</h1>
            <span class="tag-id-badge">#{tagId}</span>
            <TagChip name={primaryName} color={colorDraft} {tagId} />
          </div>
          <p class="subtitle">
            {fileCount}
            {fileCount === 1 ? 'file' : 'files'} tagged
          </p>
        </div>

        <div class="settings-row">
          <label class="color-field">
            <span class="label">Color</span>
            <span class="color-row">
              <input
                type="color"
                aria-label="Tag color"
                bind:value={colorDraft}
                disabled={settingsBusy}
                onchange={(e) => void saveColor(e.currentTarget.value)}
              />
              <span class="color-value">{colorDraft}</span>
            </span>
          </label>

          <label class="checkbox-label">
            <input
              type="checkbox"
              aria-label="Category"
              checked={isCategory}
              disabled={settingsBusy}
              onchange={(e) => void toggleCategory(e.currentTarget.checked)}
            />
            <span>Make this tag a category</span>
          </label>
        </div>
      </header>

      {#if settingsError}
        <p class="error">{settingsError}</p>
      {/if}

      <!-- Primary portion: Wiki write-up -->
      <section class="panel wiki-section" aria-label="Wiki">
        <div class="section-header">
          <h2 class="section-title">Wiki</h2>
          {#if !editingWiki}
            <Button label="Edit Wiki" accent onclick={startEditWiki} />
          {/if}
        </div>

        {#if editingWiki}
          <div class="wiki-editor">
            <div class="textarea-wrap">
              <textarea
                bind:this={wikiTextarea}
                class="wiki-textarea"
                aria-label="Wiki writeup"
                rows="8"
                placeholder="Write a markdown description for this tag. Enclose a tag in [[double brackets]] to link to it."
                disabled={savingWiki}
                bind:value={wikiDraft}
                oninput={updateWikiCursor}
                onclick={updateWikiCursor}
                onkeyup={updateWikiCursor}
                onkeydown={onWikiKeydown}
                onscroll={positionWikiSuggestions}></textarea>

              {#if wikiAutocompleteOpen}
                <ul
                  class="wiki-suggestions"
                  role="listbox"
                  aria-label="Wiki tag suggestions"
                  style:top={wikiAnchor ? `${wikiAnchor.top}px` : undefined}
                  style:left={wikiAnchor ? `${wikiAnchor.left}px` : undefined}
                >
                  {#each wikiSuggestions as suggestion, i (suggestion.tagId)}
                    <li
                      role="option"
                      aria-selected={i === wikiActiveIndex}
                      class:active={i === wikiActiveIndex}
                    >
                      <button
                        type="button"
                        tabindex="-1"
                        onmousemove={() => (wikiActiveIndex = i)}
                        onmousedown={(event) => {
                          event.preventDefault();
                          pickWikiSuggestion(suggestion);
                        }}
                      >
                        <TagChip name={suggestion.aliasText} color={suggestion.color} />
                        {#if suggestion.aliasText !== suggestion.primaryName}
                          <span class="meta">→ {suggestion.primaryName}</span>
                        {/if}
                        {#if suggestion.parentName}
                          <span class="meta">({suggestion.parentName})</span>
                        {/if}
                        <span class="count">
                          {suggestion.fileCount}
                          {suggestion.fileCount === 1 ? 'file' : 'files'}
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>

            <p class="wiki-hint">
              Supports Markdown and <code>[[tag]]</code> links. Type <code>[[</code> to search tags by
              alias.
            </p>

            {#if wikiError}
              <p class="error">{wikiError}</p>
            {/if}

            <div class="wiki-actions">
              <Button
                label="Save Wiki"
                accent
                disabled={savingWiki}
                onclick={() => void saveWiki()}
              />
              <Button label="Cancel" disabled={savingWiki} onclick={cancelEditWiki} />
            </div>
          </div>
        {:else if wikiBlocks.length === 0}
          <p class="placeholder">No wiki write-up yet. Click Edit Wiki to add one.</p>
        {:else}
          <div class="wiki-body">
            {#each wikiBlocks as block, i (i)}
              {#if block.type === 'heading'}
                {#if block.level === 1}
                  <h1>{@render renderInlines(block.inlines)}</h1>
                {:else if block.level === 2}
                  <h2>{@render renderInlines(block.inlines)}</h2>
                {:else if block.level === 3}
                  <h3>{@render renderInlines(block.inlines)}</h3>
                {:else if block.level === 4}
                  <h4>{@render renderInlines(block.inlines)}</h4>
                {:else if block.level === 5}
                  <h5>{@render renderInlines(block.inlines)}</h5>
                {:else}
                  <h6>{@render renderInlines(block.inlines)}</h6>
                {/if}
              {:else if block.type === 'paragraph'}
                <p>{@render renderInlines(block.inlines)}</p>
              {:else if block.type === 'blockquote'}
                <blockquote>{@render renderInlines(block.inlines)}</blockquote>
              {:else if block.type === 'code_block'}
                <pre><code>{block.code}</code></pre>
              {:else if block.type === 'unordered_list'}
                <ul>
                  {#each block.items as item, j (j)}
                    <li>{@render renderInlines(item)}</li>
                  {/each}
                </ul>
              {:else if block.type === 'ordered_list'}
                <ol>
                  {#each block.items as item, j (j)}
                    <li>{@render renderInlines(item)}</li>
                  {/each}
                </ol>
              {:else if block.type === 'hr'}
                <hr />
              {/if}
            {/each}
          </div>
        {/if}
      </section>

      <!-- Relationships & Values -->
      <section class="panel" aria-label="Relationships & Values">
        <h2 class="section-title">Relationships &amp; Values</h2>

        {#if relationships.length === 0}
          <p class="placeholder">No relationships or values on this tag.</p>
        {:else}
          <div class="item-list">
            {#each relationships as rel (rel.tagId)}
              <div class="relationship-group">
                <div class="relationship-header">
                  <TagChip
                    name={rel.name}
                    color={rel.color}
                    tagId={rel.tagId}
                    onclick={() => navigate(`/tags/${rel.tagId}`)}
                  />
                  <div class="relationship-actions">
                    <Button
                      label="+ Value"
                      disabled={rel.busy}
                      onclick={() => selectRelationshipForAdd(rel)}
                    />
                    <Button
                      label="Remove Relationship"
                      disabled={rel.busy}
                      onclick={() => void removeRelationship(rel)}
                    />
                  </div>
                </div>
                {#if rel.error}
                  <p class="error">{rel.error}</p>
                {/if}

                {#if rel.rows.length > 0}
                  <div class="value-list">
                    {#each rel.rows as row (row.valueId)}
                      <div class="item-card">
                        <div class="item-row">
                          <span class="kind-badge">{kindLabel(row.kind)}</span>

                          {#if row.kind === 'parent'}
                            <div class="tag-input-wrap">
                              <TagAutocompleteInput
                                libraryId={resolvedLibraryId}
                                bind:selected={row.selectedTag}
                                excludeTagId={tagId}
                                disabled={row.busy}
                                {debounceMs}
                                ariaLabel="Parent tag"
                                onSelect={(picked) => void replaceStructuralTag(row, picked)}
                              />
                            </div>
                            <label class="checkbox-label">
                              <input
                                type="checkbox"
                                aria-label="Primary parent"
                                checked={row.primary}
                                disabled={row.busy}
                                onchange={(e) =>
                                  void toggleParentPrimary(row, e.currentTarget.checked)}
                              />
                              <span>Primary</span>
                            </label>
                          {:else if row.kind === 'component'}
                            <div class="tag-input-wrap">
                              <TagAutocompleteInput
                                libraryId={resolvedLibraryId}
                                bind:selected={row.selectedTag}
                                excludeTagId={tagId}
                                disabled={row.busy}
                                {debounceMs}
                                ariaLabel="Component tag"
                                onSelect={(picked) => void replaceStructuralTag(row, picked)}
                              />
                            </div>
                            <label class="checkbox-label">
                              <input
                                type="checkbox"
                                aria-label="Recursive component"
                                checked={row.recursive}
                                disabled={row.busy}
                                onchange={(e) =>
                                  void toggleComponentFlags(
                                    row,
                                    e.currentTarget.checked,
                                    row.attributed,
                                  )}
                              />
                              <span>Recursive</span>
                            </label>
                            <label class="checkbox-label">
                              <input
                                type="checkbox"
                                aria-label="Attributed component"
                                checked={row.attributed}
                                disabled={row.busy}
                                onchange={(e) =>
                                  void toggleComponentFlags(
                                    row,
                                    row.recursive,
                                    e.currentTarget.checked,
                                  )}
                              />
                              <span>Attributed</span>
                            </label>
                          {:else if row.kind === 'text'}
                            <input
                              type="text"
                              class="value-input"
                              aria-label="Text value"
                              bind:value={row.textDraft}
                              disabled={row.busy}
                              onkeydown={(e) => onValueKeydown(e, row)}
                            />
                            <Button
                              label="Save"
                              accent
                              disabled={!canSaveValueRow(row)}
                              onclick={() => void saveValueRow(row)}
                            />
                          {:else if row.kind === 'number'}
                            <input
                              type="text"
                              inputmode="decimal"
                              class="value-input"
                              aria-label="Number value"
                              aria-invalid={isNumberInvalid(row)}
                              bind:value={row.numberDraft}
                              disabled={row.busy}
                              onkeydown={(e) => onValueKeydown(e, row)}
                            />
                            <Button
                              label="Save"
                              accent
                              disabled={!canSaveValueRow(row)}
                              onclick={() => void saveValueRow(row)}
                            />
                          {:else if row.kind === 'tag'}
                            <div class="tag-input-wrap">
                              <TagAutocompleteInput
                                libraryId={resolvedLibraryId}
                                bind:selected={row.selectedTag}
                                excludeTagId={row.instanceTagId}
                                disabled={row.busy}
                                {debounceMs}
                                ariaLabel="Tag value"
                                onSelect={(picked) => void saveTagValueRow(row, picked)}
                              />
                            </div>
                          {/if}

                          <Button
                            label="Delete"
                            disabled={row.busy}
                            onclick={() => void removeValueRow(row)}
                          />
                        </div>

                        {#if isNumberInvalid(row)}
                          <p class="validation-error">Enter a valid number.</p>
                        {/if}
                        {#if row.rowError}
                          <p class="error">{row.rowError}</p>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        <!-- Add relationship / value -->
        <div class="add-value-box">
          <span class="label">Add relationship or value</span>
          <div class="add-value-grid">
            <div class="field">
              <span class="label">Related tag</span>
              <TagAutocompleteInput
                libraryId={resolvedLibraryId}
                bind:selected={newRelatedTag}
                excludeTagId={tagId}
                disabled={addingValue}
                {debounceMs}
                ariaLabel="Related tag"
              />
            </div>

            <label class="field">
              <span class="label">Value type</span>
              <select
                aria-label="Value type"
                bind:value={newValueKind}
                disabled={addingValue}
                onchange={() => (addValueError = null)}
              >
                <option value="parent">Parent</option>
                <option value="component">Component</option>
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="tag">Tag</option>
                <option value="none">None (relationship only)</option>
              </select>
            </label>
          </div>

          {#if newValueKind === 'parent'}
            <div class="option-row">
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  aria-label="New primary parent"
                  bind:checked={newParentPrimary}
                  disabled={addingValue}
                />
                <span>Primary</span>
              </label>
            </div>
          {:else if newValueKind === 'component'}
            <div class="option-row">
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  aria-label="New recursive component"
                  bind:checked={newComponentRecursive}
                  disabled={addingValue}
                />
                <span>Recursive</span>
              </label>
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  aria-label="New attributed component"
                  bind:checked={newComponentAttributed}
                  disabled={addingValue}
                />
                <span>Attributed</span>
              </label>
            </div>
          {:else if newValueKind === 'text'}
            <input
              type="text"
              class="value-input"
              aria-label="New text value"
              placeholder="Enter text value"
              bind:value={newTextValue}
              disabled={addingValue}
            />
          {:else if newValueKind === 'number'}
            <input
              type="text"
              inputmode="decimal"
              class="value-input"
              aria-label="New number value"
              aria-invalid={newNumberInvalid}
              placeholder="Enter numeric value"
              bind:value={newNumberText}
              disabled={addingValue}
            />
            {#if newNumberInvalid}
              <p class="validation-error">Enter a valid number.</p>
            {/if}
          {:else if newValueKind === 'tag'}
            <div class="field">
              <span class="label">Referenced tag</span>
              <TagAutocompleteInput
                libraryId={resolvedLibraryId}
                bind:selected={newRefTag}
                excludeTagId={newRelatedTag?.tagId ?? tagId}
                disabled={addingValue}
                {debounceMs}
                ariaLabel="New tag value"
              />
            </div>
          {/if}

          {#if addValueError}
            <p class="error">{addValueError}</p>
          {/if}

          <div class="add-actions">
            <Button
              label="Add Value"
              accent
              disabled={!canAddValue}
              onclick={() => void createNewValue()}
            />
          </div>
        </div>
      </section>

      <!-- Aliases -->
      <section class="panel" aria-label="Aliases">
        <h2 class="section-title">Aliases</h2>
        <div class="item-list">
          {#each aliasRows as row (row.aliasId)}
            <div class="item-card">
              <div class="item-row">
                <input
                  type="text"
                  class="value-input"
                  aria-label="Alias text"
                  bind:value={row.textDraft}
                  disabled={row.busy}
                  onkeydown={(e) => onAliasKeydown(e, row)}
                />
                <label class="checkbox-label">
                  <input
                    type="checkbox"
                    aria-label="Primary alias"
                    checked={row.isPrimary}
                    disabled={row.busy}
                    onchange={(e) => void toggleAliasPrimary(row, e.currentTarget.checked)}
                  />
                  <span>Primary</span>
                </label>
                <label class="checkbox-label">
                  <input
                    type="checkbox"
                    aria-label="Shorthand alias"
                    checked={row.isShorthand}
                    disabled={row.busy}
                    onchange={(e) => void toggleAliasShorthand(row, e.currentTarget.checked)}
                  />
                  <span>Shorthand</span>
                </label>
                <Button
                  label="Save"
                  accent
                  disabled={!canSaveAlias(row)}
                  onclick={() => void saveAliasText(row)}
                />
                <Button
                  label="Delete"
                  disabled={row.busy || aliasRows.length <= 1}
                  onclick={() => void removeAliasRow(row)}
                />
              </div>
              {#if row.rowError}
                <p class="error">{row.rowError}</p>
              {/if}
            </div>
          {/each}
        </div>

        <div class="add-row">
          <input
            type="text"
            class="value-input"
            aria-label="New alias"
            placeholder="Add new alias"
            bind:value={newAliasText}
            disabled={addingAlias}
            onkeydown={onNewAliasKeydown}
          />
          <Button
            label="Add Alias"
            accent
            disabled={!canAddAlias}
            onclick={() => void createNewAlias()}
          />
        </div>
        {#if aliasError}
          <p class="error">{aliasError}</p>
        {/if}
      </section>
    </div>

    <aside class="hierarchy-sidebar" aria-label="Tag hierarchy">
      <h2>Hierarchy</h2>
      {@render renderHierarchyGroup('Parents', parents)}
      {@render renderHierarchyGroup('Ancestors', ancestors)}
      {@render renderHierarchyGroup('Children', children)}
      {@render renderHierarchyGroup('Descendants', descendants)}
    </aside>
  {/if}
</div>

<style lang="scss">
  @use '../styles/variables' as *;

  .tag-detail-page {
    display: flex;
    gap: 0;
    align-items: stretch;
    min-height: 100vh;
  }

  .main-column {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 14px;
    padding: 20px;
    background: $color-shell-bg;
  }

  .breadcrumb button {
    padding: 0;
    font-family: inherit;
    font-size: 13px;
    color: $color-text-dim;
    background: none;
    border: 0;
    cursor: pointer;

    &:hover {
      color: $color-text-strong;
    }
  }

  .tag-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .title-block {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 10px;

    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 600;
      color: $color-text-strong;
    }
  }

  .tag-id-badge {
    font-family: $font-mono;
    font-size: 12px;
    color: $color-text-dim;
  }

  .subtitle {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .settings-row {
    display: flex;
    align-items: center;
    gap: 18px;
  }

  .color-field {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .color-row {
    display: flex;
    align-items: center;
    gap: 8px;

    input[type='color'] {
      width: 32px;
      height: 28px;
      padding: 0;
      background: $color-chip-bg;
      border: 0;
      border-radius: 2px;
      cursor: pointer;
    }
  }

  .color-value {
    font-family: $font-mono;
    font-size: 12px;
    color: $color-text-dim;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    background: $color-sidebar-bg;
    border-radius: 2px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .section-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: $color-text-strong;
  }

  .label {
    font-size: 11px;
    font-weight: 600;
    color: $color-text-dim;
  }

  .checkbox-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: $color-text-strong;
    white-space: nowrap;
    cursor: pointer;
  }

  /* Wiki styles */

  .wiki-editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .textarea-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .wiki-textarea {
    width: 100%;
    min-height: 160px;
    padding: 10px;
    font-family: $font-body;
    font-size: 13px;
    line-height: 1.5;
    color: $color-text-strong;
    resize: vertical;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;

    &:focus {
      outline: none;
    }
  }

  .wiki-suggestions {
    position: absolute;
    z-index: 160;
    // Fallback when the caret cannot be measured: inline top/left override this.
    top: calc(100% + 4px);
    left: 0;
    width: 320px;
    max-width: 100%;
    max-height: 220px;
    margin: 0;
    padding: 4px;
    overflow-y: auto;
    list-style: none;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 50%);

    li button {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 12px;
      color: $color-text-strong;
      text-align: left;
      background: none;
      border: 0;
      border-radius: 2px;
      cursor: pointer;
    }

    li.active button {
      background: $color-chip-bg;
    }

    .meta {
      color: $color-text-dim;
    }

    .count {
      margin-left: auto;
      color: $color-text-dim;
      white-space: nowrap;
    }
  }

  .wiki-hint {
    margin: 0;
    font-size: 11px;
    color: $color-text-dim;

    code {
      padding: 1px 4px;
      font-family: $font-mono;
      background: $color-panel-bg;
      border-radius: 2px;
    }
  }

  .wiki-actions {
    display: flex;
    gap: 8px;
  }

  .wiki-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 14px;
    line-height: 1.6;
    color: $color-text-strong;

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      margin: 4px 0 0;
      color: $color-text-strong;
    }

    h1 {
      font-size: 18px;
    }

    h2 {
      font-size: 16px;
    }

    h3 {
      font-size: 14px;
    }

    p,
    ul,
    ol,
    blockquote,
    pre {
      margin: 0;
    }

    ul,
    ol {
      padding-left: 20px;
    }

    blockquote {
      padding-left: 10px;
      color: $color-text-dim;
      border-left: 3px solid $color-border;
    }

    code {
      padding: 1px 5px;
      font-family: $font-mono;
      font-size: 12px;
      background: $color-panel-bg;
      border: 0;
      border-radius: 2px;
    }

    pre {
      padding: 10px;
      overflow-x: auto;
      background: $color-panel-bg;
      border: 0;
      border-radius: 2px;

      code {
        padding: 0;
        background: none;
        border: 0;
      }
    }

    a {
      color: $color-jobs-accent;
      text-decoration: underline;
    }

    hr {
      width: 100%;
      border: 0;
      border-top: 1px solid $color-border;
    }
  }

  .inline-chip {
    display: inline-flex;
    vertical-align: middle;
  }

  .wiki-unresolved {
    padding: 0 4px;
    font-family: $font-mono;
    font-size: 12px;
    color: $color-text-dim;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;
  }

  /* Relationships & Aliases styles */

  .item-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .item-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: 2px;
  }

  .item-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .relationship-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;
  }

  .relationship-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .relationship-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .value-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .kind-badge {
    flex-shrink: 0;
    width: 68px;
    font-size: 11px;
    font-weight: 600;
    color: $color-text-dim;
  }

  .value-input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    font-family: inherit;
    font-size: 13px;
    color: $color-text-strong;
    background: $color-chip-bg;
    border: 1px solid transparent;
    border-radius: 2px;

    &[aria-invalid='true'] {
      border-color: $color-error;
    }
  }

  .tag-input-wrap {
    display: flex;
    flex: 1;
    min-width: 0;
  }

  .add-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .add-value-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;
  }

  .add-value-grid {
    display: grid;
    grid-template-columns: 1fr 180px;
    gap: 8px;
    align-items: end;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;

    select {
      height: 34px;
      padding: 6px 10px;
      font-family: inherit;
      font-size: 13px;
      color: $color-text-strong;
      background: $color-chip-bg;
      border: 0;
      border-radius: 2px;
    }
  }

  .option-row {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .add-actions {
    display: flex;
    justify-content: flex-end;
  }

  /* Sidebar styles */

  .hierarchy-sidebar {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex-shrink: 0;
    width: 280px;
    padding: 20px;
    background: $color-sidebar-bg;

    h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: $color-text-strong;
    }
  }

  .sidebar-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: 2px;

    h3 {
      margin: 0;
      font-size: 12px;
      font-weight: 600;
      color: $color-text-dim;
    }
  }

  .chip-wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }

  .empty-group {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .placeholder {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .validation-error,
  .error {
    margin: 0;
    font-size: 12px;
    color: $color-error;
  }
</style>
