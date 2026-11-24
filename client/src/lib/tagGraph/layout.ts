/** Layered left-to-right layout for the tag graph. Each `from -> to` edge puts `to` in
 *  a column to the right of `from`. */

export interface LayoutNode {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
}

export interface GraphLayout {
  nodes: Map<number, LayoutNode>;
  width: number;
  height: number;
}

export const NODE_HEIGHT = 26;
export const ROW_GAP = 10;
export const COLUMN_GAP = 72;

const SWEEPS = 4;

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

export function layoutGraph(
  ids: readonly number[],
  edges: readonly { from: number; to: number }[],
  widthOf: (id: number) => number,
): GraphLayout {
  const known = new Set(ids);
  const incoming = new Map<number, number[]>();
  const outgoing = new Map<number, number[]>();
  for (const { from, to } of edges) {
    if (from === to || !known.has(from) || !known.has(to)) continue;
    incoming.set(to, [...(incoming.get(to) ?? []), from]);
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  }

  // Column of a node: the longest path that leads to it. `visiting` breaks cycles.
  const layer = new Map<number, number>();
  const visiting = new Set<number>();
  const rank = (id: number): number => {
    const done = layer.get(id);
    if (done !== undefined) return done;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let value = 0;
    for (const source of incoming.get(id) ?? []) value = Math.max(value, rank(source) + 1);
    visiting.delete(id);
    layer.set(id, value);
    return value;
  };
  for (const id of ids) rank(id);
  // A node with no incoming edge moves next to its nearest target.
  for (const id of ids) {
    const targets = outgoing.get(id);
    if (incoming.has(id) || !targets) continue;
    const nearest = Math.min(...targets.map((t) => layer.get(t) ?? 0));
    if (nearest - 1 > (layer.get(id) ?? 0)) layer.set(id, nearest - 1);
  }

  const columns: number[][] = [];
  for (const id of ids) (columns[layer.get(id) ?? 0] ??= []).push(id);
  for (let i = 0; i < columns.length; i++) columns[i] ??= [];

  // Order each column by the mean position of its neighbors to cut edge crossings.
  const position = new Map<number, number>();
  const index = () => columns.forEach((col) => col.forEach((id, i) => position.set(id, i)));
  const reorder = (column: number[], neighbors: Map<number, number[]>) => {
    const key = new Map<number, number>();
    for (const id of column) {
      const near = (neighbors.get(id) ?? []).map((n) => position.get(n) ?? 0);
      key.set(id, near.length > 0 ? mean(near) : (position.get(id) ?? 0));
    }
    column.sort((a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0));
  };
  index();
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (let i = 1; i < columns.length; i++) {
      reorder(columns[i]!, incoming);
      index();
    }
    for (let i = columns.length - 2; i >= 0; i--) {
      reorder(columns[i]!, outgoing);
      index();
    }
  }

  // Vertical positions: each node moves toward its neighbors, and keeps the column order.
  const step = NODE_HEIGHT + ROW_GAP;
  const y = new Map<number, number>();
  columns.forEach((column) => column.forEach((id, i) => y.set(id, i * step)));
  const place = (column: number[], neighbors: Map<number, number[]>) => {
    let floor = Number.NEGATIVE_INFINITY;
    for (const id of column) {
      const near = (neighbors.get(id) ?? []).map((n) => y.get(n) ?? 0);
      const wanted = near.length > 0 ? mean(near) : (y.get(id) ?? 0);
      const value = Math.max(wanted, floor);
      y.set(id, value);
      floor = value + step;
    }
  };
  for (let i = 1; i < columns.length; i++) place(columns[i]!, incoming);
  for (let i = columns.length - 2; i >= 0; i--) place(columns[i]!, outgoing);
  for (let i = 1; i < columns.length; i++) place(columns[i]!, incoming);

  const top = ids.length > 0 ? Math.min(...ids.map((id) => y.get(id) ?? 0)) : 0;
  const nodes = new Map<number, LayoutNode>();
  let x = 0;
  let height = 0;
  columns.forEach((column, i) => {
    let columnWidth = 0;
    for (const id of column) {
      const w = widthOf(id);
      const nodeY = (y.get(id) ?? 0) - top;
      nodes.set(id, { id, x, y: nodeY, w, h: NODE_HEIGHT, layer: i });
      columnWidth = Math.max(columnWidth, w);
      height = Math.max(height, nodeY + NODE_HEIGHT);
    }
    x += columnWidth + COLUMN_GAP;
  });
  return { nodes, width: Math.max(0, x - COLUMN_GAP), height };
}
