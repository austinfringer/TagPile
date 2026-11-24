import { afterEach, describe, expect, it } from 'vitest';
import {
  closeContextMenu,
  closeStubModal,
  contextMenuState,
  contextTargetFrom,
  entriesFor,
  openContextMenu,
  stubModal,
  type ContextMenuEntry,
} from './contextmenu.svelte';

function labelsOf(entries: ContextMenuEntry[]): (string | 'separator')[] {
  return entries.map((e) => (e === 'separator' ? 'separator' : e.label));
}

describe('entriesFor', () => {
  afterEach(closeStubModal);
  it('shows only the global items for a generic target', () => {
    expect(labelsOf(entriesFor({ kind: 'generic' }))).toEqual(['Copy', 'Paste', 'Select All']);
  });

  it('shows View File for a file target', () => {
    const entries = entriesFor({ kind: 'file', fileId: 7, fileName: 'a.png' });
    expect(labelsOf(entries)).toEqual(['View File', 'separator', 'Copy', 'Paste', 'Select All']);

    const view = entries[0];
    expect(view).not.toBe('separator');
    if (view !== 'separator') {
      view.onSelect();
      expect(window.location.pathname).toBe('/files/7');
    }
  });

  it('shows Edit Tag and View Tag for an unattached tag', () => {
    const entries = entriesFor({ kind: 'tag', tagId: 3, tagName: 'sunset', attachedFileId: null });
    expect(labelsOf(entries)).toEqual([
      'Edit Tag',
      'View Tag',
      'separator',
      'Copy',
      'Paste',
      'Select All',
    ]);
  });

  it('adds Add Value, Edit Relationship, and Delete Relationship for a tag attached to a file', () => {
    const entries = entriesFor({ kind: 'tag', tagId: 3, tagName: 'sunset', attachedFileId: 9 });
    expect(labelsOf(entries)).toEqual([
      'Add Value',
      'Edit Relationship',
      'Delete Relationship',
      'Edit Tag',
      'View Tag',
      'separator',
      'Copy',
      'Paste',
      'Select All',
    ]);
  });

  it('opens the edit-tag stub from its item', () => {
    const entries = entriesFor({ kind: 'tag', tagId: 3, tagName: 'sunset', attachedFileId: null });
    const edit = entries[0];
    expect(edit).not.toBe('separator');
    if (edit !== 'separator') edit.onSelect();
    expect(stubModal()).toEqual({ kind: 'edit-tag', tagId: 3, tagName: 'sunset' });
  });

  it('disables Paste when no editable element is focused', () => {
    const entries = entriesFor({ kind: 'generic' });
    const paste = entries.find((e) => e !== 'separator' && e.label === 'Paste');
    expect(paste).not.toBe('separator');
    if (paste !== 'separator') expect(paste?.disabled).toBe(true);
  });
});

describe('contextTargetFrom', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves generic without a marker', () => {
    expect(contextTargetFrom(document.body)).toEqual({ kind: 'generic' });
    expect(contextTargetFrom(null)).toEqual({ kind: 'generic' });
  });

  it('resolves the nearest tag marker, attached when data-attached-file is set', () => {
    document.body.innerHTML =
      '<div data-context="tag" data-tag-id="4" data-tag-name="mountain"><span id="inner"></span></div>';
    expect(contextTargetFrom(document.getElementById('inner'))).toEqual({
      kind: 'tag',
      tagId: 4,
      tagName: 'mountain',
      attachedFileId: null,
    });

    document.body.innerHTML =
      '<div data-context="tag" data-tag-id="4" data-tag-name="mountain" data-attached-file="12"><span id="inner"></span></div>';
    expect(contextTargetFrom(document.getElementById('inner'))).toEqual({
      kind: 'tag',
      tagId: 4,
      tagName: 'mountain',
      attachedFileId: 12,
    });
  });

  it('resolves a file marker', () => {
    document.body.innerHTML =
      '<div data-context="file" data-file-id="8" data-file-name="b.jpg"><img id="inner" /></div>';
    expect(contextTargetFrom(document.getElementById('inner'))).toEqual({
      kind: 'file',
      fileId: 8,
      fileName: 'b.jpg',
    });
  });

  it('prefers the innermost marker when they nest', () => {
    document.body.innerHTML =
      '<div data-context="file" data-file-id="8"><span data-context="tag" data-tag-id="4" id="inner"></span></div>';
    expect(contextTargetFrom(document.getElementById('inner'))).toMatchObject({
      kind: 'tag',
      tagId: 4,
    });
  });
});

describe('openContextMenu', () => {
  afterEach(() => {
    closeContextMenu();
  });

  it('opens the menu at the click point and prevents the default', () => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { clientX: { value: 50 }, clientY: { value: 60 } });
    expect(openContextMenu(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(contextMenuState()).toMatchObject({ x: 50, y: 60 });
    expect(labelsOf(contextMenuState()!.entries)).toEqual(['Copy', 'Paste', 'Select All']);
  });

  it('passes through when Ctrl is held, leaving the native menu intact', () => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ctrlKey: true });
    expect(openContextMenu(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(contextMenuState()).toBeNull();
  });
});
