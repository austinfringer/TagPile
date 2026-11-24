/** Pure graph logic for the Manage tags page: indexes over the tag graph, the tree
 *  rows, and the subgraph that the graph view draws. */

import type { TagGraph, TagGraphEdge, TagGraphNode } from '../api';

export interface TagGraphIndex {
  nodes: Map<number, TagGraphNode>;
  /** Position of each tag in the name-ordered server list. */
  order: Map<number, number>;
  /** Parents of each tag, the primary parent first. */
  parents: Map<number, number[]>;
  children: Map<number, number[]>;
  /** Components of each tag. */
  components: Map<number, number[]>;
  /** Tags that have the key tag as a component. */
  componentOf: Map<number, number[]>;
  /** Instances on each tag that hold values, or that are not structural. */
  others: Map<number, TagGraphEdge[]>;
  /** Edges keyed by `edgeKey(subjectTagId, tagId)`. */
  edges: Map<string, TagGraphEdge>;
  /** Tags with no parent. */
  roots: number[];
}

export const edgeKey = (subjectTagId: number, tagId: number) => `${subjectTagId}:${tagId}`;

function push<V>(map: Map<number, V[]>, key: number, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildIndex(graph: TagGraph | null): TagGraphIndex {
  const nodes = new Map<number, TagGraphNode>();
  const order = new Map<number, number>();
  for (const [i, tag] of (graph?.tags ?? []).entries()) {
    nodes.set(tag.tagId, tag);
    order.set(tag.tagId, i);
  }
  const parents = new Map<number, number[]>();
  const children = new Map<number, number[]>();
  const components = new Map<number, number[]>();
  const componentOf = new Map<number, number[]>();
  const others = new Map<number, TagGraphEdge[]>();
  const edges = new Map<string, TagGraphEdge>();
  for (const edge of graph?.edges ?? []) {
    const { subjectTagId, tagId } = edge;
    if (!nodes.has(subjectTagId) || !nodes.has(tagId)) continue;
    edges.set(edgeKey(subjectTagId, tagId), edge);
    if (edge.parent) {
      push(parents, subjectTagId, tagId);
      push(children, tagId, subjectTagId);
    }
    if (edge.component) {
      push(components, subjectTagId, tagId);
      push(componentOf, tagId, subjectTagId);
    }
    if (edge.valueCount > 0 || (!edge.parent && !edge.component)) push(others, subjectTagId, edge);
  }
  const byOrder = (a: number, b: number) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  for (const map of [children, components, componentOf]) {
    for (const list of map.values()) list.sort(byOrder);
  }
  for (const [subject, list] of parents) {
    const primary = (id: number) => (edges.get(edgeKey(subject, id))?.primary ? 0 : 1);
    list.sort((a, b) => primary(a) - primary(b) || byOrder(a, b));
  }
  const roots = [...nodes.keys()].filter((id) => !parents.has(id));
  return { nodes, order, parents, children, components, componentOf, others, edges, roots };
}

/** Tags reachable from `id` through `step`, up to `maxDepth` steps. `id` is not included. */
function reach(
  step: Map<number, number[]>,
  id: number,
  maxDepth = Number.POSITIVE_INFINITY,
): Set<number> {
  const seen = new Set<number>();
  let frontier = [id];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const current of frontier) {
      for (const other of step.get(current) ?? []) {
        if (other === id || seen.has(other)) continue;
        seen.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return seen;
}

export const ancestorsOf = (index: TagGraphIndex, id: number) => reach(index.parents, id);

export const descendantsOf = (index: TagGraphIndex, id: number, maxDepth?: number) =>
  reach(index.children, id, maxDepth);

/** True when the parent edge `childId -> parentId` would close a cycle. */
export function wouldCycle(index: TagGraphIndex, childId: number, parentId: number): boolean {
  return childId === parentId || descendantsOf(index, childId).has(parentId);
}

const sorted = (index: TagGraphIndex, ids: Iterable<number>) =>
  [...ids].sort((a, b) => (index.order.get(a) ?? 0) - (index.order.get(b) ?? 0));

/** The tags drawn around a focus tag: all its ancestors, its descendants down to
 *  `depth` levels, and optionally its components and the tags it is a component of. */
export function neighborhood(
  index: TagGraphIndex,
  focusId: number,
  depth: number,
  withComponents: boolean,
): number[] {
  const ids = new Set<number>([focusId]);
  for (const id of ancestorsOf(index, focusId)) ids.add(id);
  for (const id of descendantsOf(index, focusId, depth)) ids.add(id);
  if (withComponents) {
    for (const id of index.components.get(focusId) ?? []) ids.add(id);
    for (const id of index.componentOf.get(focusId) ?? []) ids.add(id);
  }
  return sorted(index, ids);
}

/** The tags drawn when no tag has the focus: tags that take part in a relationship,
 *  level by level from the roots, up to `cap` tags. `hidden` counts the tags left out. */
export function overview(
  index: TagGraphIndex,
  cap: number,
  withComponents: boolean,
): { ids: number[]; hidden: number } {
  const ids = new Set<number>();
  let frontier = index.roots.filter((id) => index.children.has(id));
  while (frontier.length > 0 && ids.size < cap) {
    const next: number[] = [];
    for (const id of frontier) {
      if (ids.size >= cap) break;
      if (ids.has(id)) continue;
      ids.add(id);
      next.push(...(index.children.get(id) ?? []));
    }
    frontier = next;
  }
  if (withComponents) {
    for (const [owner, parts] of index.components) {
      for (const id of [owner, ...parts]) {
        if (ids.size >= cap) break;
        ids.add(id);
      }
    }
  }
  return { ids: sorted(index, ids), hidden: index.nodes.size - ids.size };
}

export interface ViewEdge {
  /** Parent edge: the parent. Component edge: the owner. */
  from: number;
  /** Parent edge: the child. Component edge: the component. */
  to: number;
  kind: 'parent' | 'component';
  primary: boolean;
}

/** The edges between the tags in `ids`. `rank` holds the edges that set the columns of
 *  the layout: all parent edges, and a component edge only when one of its ends has no
 *  parent edge in the view. */
export function viewEdges(
  index: TagGraphIndex,
  ids: readonly number[],
  withComponents: boolean,
): { edges: ViewEdge[]; rank: { from: number; to: number }[] } {
  const inView = new Set(ids);
  const edges: ViewEdge[] = [];
  const inHierarchy = new Set<number>();
  for (const id of ids) {
    for (const parent of index.parents.get(id) ?? []) {
      if (!inView.has(parent)) continue;
      const primary = index.edges.get(edgeKey(id, parent))?.primary ?? false;
      edges.push({ from: parent, to: id, kind: 'parent', primary });
      inHierarchy.add(id).add(parent);
    }
  }
  const rank = edges.map(({ from, to }) => ({ from, to }));
  if (withComponents) {
    for (const id of ids) {
      for (const part of index.components.get(id) ?? []) {
        if (!inView.has(part)) continue;
        edges.push({ from: id, to: part, kind: 'component', primary: false });
        if (!inHierarchy.has(id) || !inHierarchy.has(part)) rank.push({ from: id, to: part });
      }
    }
  }
  return { edges, rank };
}

/** Tags whose name or alias contains `query`, and those tags plus their ancestors.
 *  Returns null for an empty query. */
export function searchTags(
  index: TagGraphIndex,
  query: string,
): { matches: Set<number>; visible: Set<number> } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const matches = new Set<number>();
  for (const tag of index.nodes.values()) {
    if (
      tag.name.toLowerCase().includes(q) ||
      tag.aliases.some((alias) => alias.toLowerCase().includes(q))
    ) {
      matches.add(tag.tagId);
    }
  }
  const visible = new Set(matches);
  for (const id of matches) {
    for (const ancestor of ancestorsOf(index, id)) visible.add(ancestor);
  }
  return { matches, visible };
}

export interface TreeRow {
  /** Path of tag ids from a root, such as `/3/8`. A tag with two parents has two rows. */
  key: string;
  tagId: number;
  depth: number;
  childCount: number;
  expanded: boolean;
}

const MAX_TREE_DEPTH = 64;

/** The rows of the tag tree. A row shows its children when its key is in `expanded`.
 *  When `visible` is set, only those tags show and every row is expanded. */
export function treeRows(
  index: TagGraphIndex,
  expanded: ReadonlySet<string>,
  visible: ReadonlySet<number> | null = null,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const allowed = (ids: readonly number[]) =>
    visible === null ? ids : ids.filter((id) => visible.has(id));
  const visit = (tagId: number, parentKey: string, depth: number) => {
    const key = `${parentKey}/${tagId}`;
    const children = allowed(index.children.get(tagId) ?? []);
    const open = depth < MAX_TREE_DEPTH && (visible !== null || expanded.has(key));
    rows.push({ key, tagId, depth, childCount: children.length, expanded: open });
    if (open) for (const child of children) visit(child, key, depth + 1);
  };
  for (const root of allowed(index.roots)) visit(root, '', 0);
  return rows;
}

/** The row keys to expand so that the tree shows `tagId`, along its first parents. */
export function pathKeys(index: TagGraphIndex, tagId: number): string[] {
  const chain: number[] = [];
  const seen = new Set<number>([tagId]);
  let current = index.parents.get(tagId)?.[0];
  while (current !== undefined && !seen.has(current)) {
    chain.unshift(current);
    seen.add(current);
    current = index.parents.get(current)?.[0];
  }
  const keys: string[] = [];
  let key = '';
  for (const id of chain) {
    key = `${key}/${id}`;
    keys.push(key);
  }
  return keys;
}
