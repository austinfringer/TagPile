import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileSummary } from '../api';
import StackViewerModal from './StackViewerModal.svelte';

const ONE: FileSummary = {
  fileId: 1,
  name: 'one.png',
  path: 'one.png',
  type: 'image',
  extension: 'png',
  size: 10,
  missing: false,
  locationCount: 1,
};
const TWO: FileSummary = {
  fileId: 2,
  name: 'two.txt',
  path: 'docs/two.txt',
  type: 'text',
  extension: 'txt',
  size: 20,
  missing: false,
  locationCount: 1,
};
const THREE: FileSummary = {
  fileId: 3,
  name: 'three.jpg',
  path: 'three.jpg',
  type: 'image',
  extension: 'jpg',
  size: 30,
  missing: false,
  locationCount: 1,
};

const FILES = new Map(
  [ONE, TWO, THREE].map((file) => [file.fileId, file] as [number, FileSummary]),
);

function open(selection = [1, 2, 3], onClose = vi.fn()) {
  render(StackViewerModal, { selection, filesById: FILES, onClose });
  return onClose;
}

describe('StackViewerModal', () => {
  afterEach(() => cleanup());

  it('opens on the most recently selected file, pointed at the content endpoint', () => {
    open();
    expect(screen.getByRole('img', { name: 'three.jpg' })).toHaveAttribute(
      'src',
      '/api/files/3/content',
    );
    expect(screen.getByText('three.jpg')).toBeInTheDocument();
    expect(screen.getByText('3 of 3')).toBeInTheDocument();
  });

  it('flips through the stack with the arrow buttons, wrapping at the ends', async () => {
    open();

    // Next from the last entry wraps back to the first one.
    await fireEvent.click(screen.getByRole('button', { name: 'Next file' }));
    expect(screen.getByRole('img', { name: 'one.png' })).toHaveAttribute(
      'src',
      '/api/files/1/content',
    );
    expect(screen.getByText('1 of 3')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Next file' }));
    expect(screen.getByText('two.txt')).toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();

    // Previous from the middle entry goes back to the first image.
    await fireEvent.click(screen.getByRole('button', { name: 'Previous file' }));
    expect(screen.getByRole('img', { name: 'one.png' })).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();

    // Previous from the first entry wraps to the last one.
    await fireEvent.click(screen.getByRole('button', { name: 'Previous file' }));
    expect(screen.getByText('3 of 3')).toBeInTheDocument();
  });

  it('shows the extension placeholder for non-image files instead of an image', async () => {
    open();
    await fireEvent.click(screen.getByRole('button', { name: 'Next file' })); // one.png
    await fireEvent.click(screen.getByRole('button', { name: 'Next file' })); // two.txt

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('TXT')).toBeInTheDocument();
    expect(screen.getByText('two.txt')).toBeInTheDocument();
  });

  it('flips with the arrow keys and closes on Escape', async () => {
    const onClose = open();

    await fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(screen.getByText('two.txt')).toBeInTheDocument();

    await fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(screen.getByText('three.jpg')).toBeInTheDocument();

    await fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click, but not on a click inside the viewer', async () => {
    const onClose = open();
    const dialog = screen.getByRole('dialog', { name: 'Selected files' });
    const overlay = dialog.parentElement!;

    await fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    await fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
