import { fetchLibraries, removeTag } from '../api';
import { navigate } from '../router.svelte';
import { clearTagStore } from '../tagStore.svelte';

/** Active library id set by the workspace page, or resolved lazily from `/api/libraries`. */
let activeLibrary = $state<number | null>(null);

/** Monotonic counter bumped whenever a relationship or value changes from a menu or modal. */
let relStamp = $state(0);

export function activeLibraryId(): number | null {
  return activeLibrary;
}

export function setActiveLibraryId(libraryId: number | null): void {
  if (libraryId === null || (activeLibrary !== null && activeLibrary !== libraryId)) {
    clearTagStore();
  }
  activeLibrary = libraryId;
}

export function relationshipStamp(): number {
  return relStamp;
}

export function notifyRelationshipChanged(): void {
  relStamp++;
}

export async function resolveLibraryId(explicit?: number | null): Promise<number> {
  if (explicit !== undefined && explicit !== null) return explicit;
  if (activeLibrary !== null) return activeLibrary;
  const libs = await fetchLibraries();
  const first = libs[0];
  if (!first) throw new Error('No library selected');
  activeLibrary = first.library_id;
  return first.library_id;
}

export async function deleteRelationship(
  fileId: number,
  tagId: number,
  libraryId?: number | null,
): Promise<void> {
  try {
    const libId = await resolveLibraryId(libraryId);
    await removeTag(libId, fileId, tagId);
    notifyRelationshipChanged();
  } catch {
    // Background context menu action: ignore network errors when no library is loaded.
  }
}

/** One clickable row in the context menu. */
export interface ContextMenuItem {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

export type ContextMenuEntry = ContextMenuItem | 'separator';

/** What was right-clicked, resolved from the nearest `[data-context]` ancestor. */
export type ContextTarget =
  | { kind: 'tag'; tagId: number; tagName: string; attachedFileId: number | null }
  | { kind: 'file'; fileId: number; fileName: string }
  | { kind: 'generic' };

interface MenuState {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
}

let menu = $state<MenuState | null>(null);

/** State of the open menu, or null when closed. */
export function contextMenuState(): MenuState | null {
  return menu;
}

export function closeContextMenu(): void {
  menu = null;
}

/** The stub modal the context menu last asked for, or null. Modals render after the
 *  menu closes, so the menu never fights a dialog for the top layer. */
export type StubModal =
  | { kind: 'edit-tag'; tagId: number; tagName: string }
  | { kind: 'add-value'; tagId: number; tagName: string; fileId: number }
  | { kind: 'edit-relationship'; tagId: number; tagName: string; fileId: number };

let stub = $state<StubModal | null>(null);

export function stubModal(): StubModal | null {
  return stub;
}

export function closeStubModal(): void {
  stub = null;
}

function openStub(request: StubModal): void {
  stub = request;
}

/** Resolve the nearest element carrying a `data-context` marker. */
export function contextTargetFrom(target: EventTarget | null): ContextTarget {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-context]') : null;
  if (!el) return { kind: 'generic' };
  if (el.dataset.context === 'tag') {
    const tagId = Number(el.dataset.tagId);
    if (Number.isNaN(tagId)) return { kind: 'generic' };
    const attached = el.dataset.attachedFile;
    return {
      kind: 'tag',
      tagId,
      tagName: el.dataset.tagName ?? `#${tagId}`,
      attachedFileId: attached === undefined ? null : Number(attached),
    };
  }
  if (el.dataset.context === 'file') {
    const fileId = Number(el.dataset.fileId);
    if (Number.isNaN(fileId)) return { kind: 'generic' };
    return { kind: 'file', fileId, fileName: el.dataset.fileName ?? `#${fileId}` };
  }
  return { kind: 'generic' };
}

/** The text input or textarea that currently has focus, if any. */
function editableFocus(): HTMLInputElement | HTMLTextAreaElement | null {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
}

function copyAvailable(): boolean {
  const el = editableFocus();
  if (el) return (el.selectionStart ?? 0) !== (el.selectionEnd ?? 0);
  return (window.getSelection()?.toString() ?? '') !== '';
}

function copySelection(): void {
  const el = editableFocus();
  const text = el
    ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
    : (window.getSelection()?.toString() ?? '');
  if (text !== '') void navigator.clipboard?.writeText(text).catch(() => {});
}

async function pasteIntoFocused(): Promise<void> {
  const el = editableFocus();
  const text = el ? await navigator.clipboard?.readText().catch(() => null) : null;
  if (!el || text === null || text === undefined) return;
  el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length);
  // setRangeText does not fire input; dispatch so bound values stay in sync.
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function selectAll(): void {
  const el = editableFocus();
  if (el) el.select();
  else window.getSelection()?.selectAllChildren(document.body);
}

/** The full entry list for a target: context-specific rows, a separator, then the
 *  always-available clipboard rows. */
export function entriesFor(target: ContextTarget): ContextMenuEntry[] {
  const specific: ContextMenuItem[] = [];
  if (target.kind === 'tag') {
    const { tagId, tagName, attachedFileId } = target;
    if (attachedFileId !== null) {
      specific.push({
        label: 'Add Value',
        onSelect: () => openStub({ kind: 'add-value', tagId, tagName, fileId: attachedFileId }),
      });
      specific.push({
        label: 'Edit Relationship',
        onSelect: () =>
          openStub({ kind: 'edit-relationship', tagId, tagName, fileId: attachedFileId }),
      });
      specific.push({
        label: 'Delete Relationship',
        onSelect: () => void deleteRelationship(attachedFileId, tagId),
      });
    }
    specific.push({
      label: 'Edit Tag',
      onSelect: () => openStub({ kind: 'edit-tag', tagId, tagName }),
    });
    specific.push({ label: 'View Tag', onSelect: () => navigate(`/tags/${tagId}`) });
  } else if (target.kind === 'file') {
    specific.push({ label: 'View File', onSelect: () => navigate(`/files/${target.fileId}`) });
  }
  const global: ContextMenuItem[] = [
    { label: 'Copy', disabled: !copyAvailable(), onSelect: copySelection },
    {
      label: 'Paste',
      disabled: editableFocus() === null,
      onSelect: () => void pasteIntoFocused(),
    },
    { label: 'Select All', onSelect: selectAll },
  ];
  return specific.length > 0 ? [...specific, 'separator', ...global] : global;
}

/** Handle a `contextmenu` event. Returns false when the native menu should appear
 *  (Ctrl held, giving the user a way around the custom menu). */
export function openContextMenu(event: MouseEvent): boolean {
  if (event.ctrlKey) return false;
  event.preventDefault();
  menu = {
    x: event.clientX,
    y: event.clientY,
    entries: entriesFor(contextTargetFrom(event.target)),
  };
  return true;
}
