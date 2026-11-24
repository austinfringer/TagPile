import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSelection,
  isSelected,
  mostRecentSelection,
  selectionCount,
  selectionIds,
  toggleSelection,
} from './selection.svelte';

describe('selection', () => {
  beforeEach(() => clearSelection());

  it('starts empty', () => {
    expect(selectionIds()).toEqual([]);
    expect(selectionCount()).toBe(0);
    expect(mostRecentSelection()).toBeNull();
  });

  it('adds ids in selection order and tracks the most recent', () => {
    toggleSelection(3);
    toggleSelection(7);
    toggleSelection(5);

    expect(selectionIds()).toEqual([3, 7, 5]);
    expect(isSelected(7)).toBe(true);
    expect(isSelected(9)).toBe(false);
    expect(mostRecentSelection()).toBe(5);
  });

  it('toggling a selected id removes it', () => {
    toggleSelection(3);
    toggleSelection(7);
    toggleSelection(7);

    expect(selectionIds()).toEqual([3]);
    expect(mostRecentSelection()).toBe(3);
  });

  it('re-selecting a removed id makes it the most recent again', () => {
    toggleSelection(3);
    toggleSelection(7);
    toggleSelection(3);
    toggleSelection(3);

    expect(selectionIds()).toEqual([7, 3]);
    expect(mostRecentSelection()).toBe(3);
  });

  it('clear empties the selection', () => {
    toggleSelection(1);
    toggleSelection(2);
    clearSelection();

    expect(selectionIds()).toEqual([]);
    expect(mostRecentSelection()).toBeNull();
  });
});
