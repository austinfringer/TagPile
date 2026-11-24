/** The shared file selection: an ordered list of file ids, most recently selected last.
 *  Any feature (the tag workspace today, batch operations later) reads the same state
 *  through these accessors. */

let ids = $state<number[]>([]);

/** The selected file ids in selection order. */
export function selectionIds(): number[] {
  return ids;
}

export function selectionCount(): number {
  return ids.length;
}

export function isSelected(fileId: number): boolean {
  return ids.includes(fileId);
}

/** The last file the user selected, or null when the selection is empty. */
export function mostRecentSelection(): number | null {
  return ids.length === 0 ? null : ids[ids.length - 1]!;
}

export function toggleSelection(fileId: number): void {
  const index = ids.indexOf(fileId);
  if (index >= 0) ids.splice(index, 1);
  else ids.push(fileId);
}

//Altered, selecting a file clears the rest of the selection, unless ctrl is held
export function select(fileId: number, event?: MouseEvent): void {
  if (!event?.ctrlKey) {
    const selectCurrent = !ids.includes(fileId);
    clearSelection();
    if (selectCurrent) {
      ids.push(fileId);
    }
  } else {
    toggleSelection(fileId);
  }
}

export function clearSelection(): void {
  ids = [];
}
