import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContextMenu from './ContextMenu.svelte';
import { setActiveLibraryId } from './contextmenu.svelte';

/** Render the menu plus a context target inside the test container. */
function renderWithTarget(markup: string): HTMLElement {
  const { container } = render(ContextMenu);
  const host = document.createElement('div');
  host.innerHTML = markup;
  container.appendChild(host);
  return host;
}

function menuLabels(): string[] {
  return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
}

describe('ContextMenu', () => {
  afterEach(() => {
    cleanup();
    setActiveLibraryId(null);
    vi.unstubAllGlobals();
  });

  it('shows the global items on a plain right-click', async () => {
    render(ContextMenu);
    await fireEvent.contextMenu(document.body);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(menuLabels()).toEqual(['Copy', 'Paste', 'Select All']);
  });

  it('shows tag items for a tag target', async () => {
    const host = renderWithTarget(
      '<span data-context="tag" data-tag-id="5" data-tag-name="sunset">sunset</span>',
    );
    await fireEvent.contextMenu(host.firstElementChild!);
    expect(menuLabels()).toEqual(['Edit Tag', 'View Tag', 'Copy', 'Paste', 'Select All']);
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('adds Add Value, Edit Relationship, and Delete Relationship for a tag attached to a file', async () => {
    const host = renderWithTarget(
      '<span data-context="tag" data-tag-id="5" data-tag-name="sunset" data-attached-file="9">sunset</span>',
    );
    await fireEvent.contextMenu(host.firstElementChild!);
    expect(menuLabels()).toEqual([
      'Add Value',
      'Edit Relationship',
      'Delete Relationship',
      'Edit Tag',
      'View Tag',
      'Copy',
      'Paste',
      'Select All',
    ]);
  });

  it('deletes the relationship from the file when Delete Relationship is selected', async () => {
    setActiveLibraryId(3);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    });

    const host = renderWithTarget(
      '<span data-context="tag" data-tag-id="5" data-tag-name="sunset" data-attached-file="9">sunset</span>',
    );
    await fireEvent.contextMenu(host.firstElementChild!);
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Relationship' }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/files/9/tags/5',
        init: { method: 'DELETE' },
      });
    });
  });

  it('shows View File for a file target and navigates on select', async () => {
    const host = renderWithTarget(
      '<div data-context="file" data-file-id="8" data-file-name="b.jpg">b.jpg</div>',
    );
    await fireEvent.contextMenu(host.firstElementChild!);
    expect(menuLabels()).toEqual(['View File', 'Copy', 'Paste', 'Select All']);

    await fireEvent.click(screen.getByRole('menuitem', { name: 'View File' }));
    expect(window.location.pathname).toBe('/files/8');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('leaves the native menu alone when Ctrl is held', async () => {
    render(ContextMenu);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ctrlKey: true });
    document.body.dispatchEvent(event);
    await Promise.resolve();
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape and on a click outside the menu', async () => {
    render(ContextMenu);
    await fireEvent.contextMenu(document.body);
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    await fireEvent.contextMenu(document.body);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await fireEvent.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the Edit Tag stub after the menu closes', async () => {
    const host = renderWithTarget(
      '<span data-context="tag" data-tag-id="5" data-tag-name="sunset">sunset</span>',
    );
    await fireEvent.contextMenu(host.firstElementChild!);
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Edit Tag' }));

    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Edit Tag' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('passes the file id to Add Value and Edit Relationship stubs', async () => {
    const host = renderWithTarget(
      '<span data-context="tag" data-tag-id="5" data-tag-name="sunset" data-attached-file="9">sunset</span>',
    );
    await fireEvent.contextMenu(host.firstElementChild!);
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Add Value' }));
    const addValue = screen.getByRole('dialog', { name: 'Add Value' });
    expect(addValue.textContent).toContain('#9');
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    await fireEvent.contextMenu(host.firstElementChild!);
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Edit Relationship' }));
    const editRel = screen.getByRole('dialog', { name: 'Edit Relationship' });
    expect(editRel.textContent).toContain('#9');
  });
});
