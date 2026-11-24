<script lang="ts">
  import Button from '../Button.svelte';
  import TagChip from '../TagChip.svelte';
  import {
    addAlias,
    addTagValue,
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
    type TagInstance,
    type TagSummary,
    type TagValue,
  } from '../api';
  import { notifyRelationshipChanged, resolveLibraryId } from '../contextmenu/contextmenu.svelte';
  import { tagStore, upsertTag, upsertTagDetail } from '../tagStore.svelte';
  import { DEFAULT_TAG_COLOR } from '../tagColors';
  import TagAutocompleteInput, { type SelectedTag } from './TagAutocompleteInput.svelte';

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

  let {
    tagId,
    tagName,
    libraryId = null,
    debounceMs = 150,
    onClose,
  }: {
    tagId: number;
    tagName: string;
    libraryId?: number | null;
    debounceMs?: number;
    onClose: () => void;
  } = $props();

  let resolvedLibraryId = $state<number | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let colorDraft = $state(DEFAULT_TAG_COLOR);
  let isCategory = $state(false);
  let settingsBusy = $state(false);
  let settingsError = $state<string | null>(null);

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

  function tagChipInfo(id: number, fallbackName?: string | null): SelectedTag {
    const info = tagsById.get(id);
    return {
      tagId: id,
      name: info?.name ?? fallbackName ?? `#${id}`,
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

  function applyDetail(detail: TagDetail) {
    upsertTagDetail(detail, resolvedLibraryId);
    colorDraft = detail.tag.color ?? DEFAULT_TAG_COLOR;
    isCategory = detail.tag.is_category === 1;
    aliasRows = detail.aliases.map(toAliasRow);
    relationships = detail.instances.map(toRelationship);
  }

  async function reloadTag(libId: number) {
    const detail = await fetchTag(libId, tagId);
    applyDetail(detail);
  }

  $effect(() => {
    const explicit = libraryId;
    const tId = tagId;
    let cancelled = false;
    loading = true;
    loadError = null;

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
      // A tag keeps a primary alias; if another alias exists, promote it.
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

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onClose();
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

<svelte:window onkeydown={onKeydown} />

<div class="overlay" role="presentation">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Edit Tag">
    <p class="modal-title">Edit Tag</p>
    <p class="modal-body">
      Editing <span class="tag-name">{tagName}</span> (#{tagId}).
    </p>

    {#if loading}
      <p class="placeholder">Loading tag…</p>
    {:else if loadError}
      <p class="error">{loadError}</p>
    {:else}
      <div class="modal-scroll">
        <!-- Tag properties: color & category -->
        <section class="section">
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
          {#if settingsError}
            <p class="error">{settingsError}</p>
          {/if}
        </section>

        <!-- Aliases -->
        <section class="section">
          <h3 class="section-title">Aliases</h3>
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

        <!-- Tag-Tag Relationships & Values -->
        <section class="section">
          <h3 class="section-title">Relationships &amp; Values</h3>

          {#if relationships.length === 0}
            <p class="placeholder">No relationships or values on this tag.</p>
          {:else}
            <div class="item-list">
              {#each relationships as rel (rel.tagId)}
                <div class="relationship-group">
                  <div class="relationship-header">
                    <TagChip name={rel.name} color={rel.color} tagId={rel.tagId} />
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
      </div>
    {/if}

    <div class="modal-actions">
      <Button label="Close" onclick={onClose} />
    </div>
  </div>
</div>

<style lang="scss">
  @use '../../styles/variables' as *;

  .overlay {
    position: fixed;
    inset: 0;
    z-index: 150;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgb(0 0 0 / 60%);
  }

  .modal {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 560px;
    max-height: 85vh;
    padding: 16px;
    background: $color-sidebar-bg;
    border: 0;
    border-radius: 2px;
  }

  .modal-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: $color-text-strong;
  }

  .modal-body {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .tag-name {
    font-weight: 600;
    color: $color-text-strong;
  }

  .placeholder {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .modal-scroll {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 16px;
    overflow-y: auto;
    padding-right: 4px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .section-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: $color-text-strong;
  }

  .settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: 2px;
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
      width: 36px;
      height: 26px;
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

  .checkbox-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: $color-text-strong;
    white-space: nowrap;
    cursor: pointer;
  }

  .item-list,
  .value-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
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
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;

    select {
      width: 100%;
      min-height: 34px;
      padding: 6px 10px;
      font-family: inherit;
      font-size: 13px;
      color: $color-text-strong;
      background: $color-chip-bg;
      border: 0;
      border-radius: 2px;
    }
  }

  .label {
    font-size: 11px;
    color: $color-text-dim;
  }

  .option-row {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .add-actions {
    display: flex;
    justify-content: flex-end;
  }

  .validation-error,
  .error {
    margin: 0;
    font-size: 12px;
    color: $color-error;
  }

  .modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
