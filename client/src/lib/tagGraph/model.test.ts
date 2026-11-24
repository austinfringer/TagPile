import { describe, expect, it } from 'vitest';
import type { TagGraph, TagGraphEdge, TagGraphNode } from '../api';
import { layoutGraph, NODE_HEIGHT, ROW_GAP } from './layout';
import {
  ancestorsOf,
  buildIndex,
  descendantsOf,
  neighborhood,
  overview,
  pathKeys,
  searchTags,
  treeRows,
  viewEdges,
  wouldCycle,
} from './model';

const node = (tagId: number, name: string, aliases: string[] = []): TagGraphNode => ({
  tagId,
  name,
  color: null,
  isCategory: false,
  fileCount: 0,
  parentName: null,
  aliases,
});

const edge = (
  subjectTagId: number,
  tagId: number,
  flags: Partial<TagGraphEdge> = { parent: true },
): TagGraphEdge => ({
  subjectTagId,
  tagId,
  parent: false,
  primary: false,
  component: false,
  valueCount: 0,
  ...flags,
});

// character(1) > mario(3) > baby mario(4); pet(2) > mario(3) (primary); mario has the
// component overalls(5); lonely(6) has no relationship; mario holds a value on lonely.
const GRAPH: TagGraph = {
  tags: [
    node(4, 'baby mario'),
    node(1, 'character'),
    node(6, 'lonely'),
    node(3, 'mario', ['jumpman']),
    node(5, 'overalls'),
    node(2, 'pet'),
  ],
  edges: [
    edge(3, 1),
    edge(3, 2, { parent: true, primary: true }),
    edge(4, 3),
    edge(3, 5, { component: true }),
    edge(3, 6, { valueCount: 2 }),
  ],
};

describe('tag graph model', () => {
  const index = buildIndex(GRAPH);

  it('indexes parents, children, components, and roots', () => {
    expect(index.parents.get(3)).toEqual([2, 1]);
    expect(index.children.get(1)).toEqual([3]);
    expect(index.components.get(3)).toEqual([5]);
    expect(index.componentOf.get(5)).toEqual([3]);
    expect(index.others.get(3)?.map((e) => e.tagId)).toEqual([6]);
    expect(index.roots).toEqual([1, 6, 5, 2]);
    expect(buildIndex(null).roots).toEqual([]);
  });

  it('walks ancestors and descendants', () => {
    expect([...ancestorsOf(index, 4)].sort()).toEqual([1, 2, 3]);
    expect([...descendantsOf(index, 1)].sort()).toEqual([3, 4]);
    expect([...descendantsOf(index, 1, 1)]).toEqual([3]);
  });

  it('detects parent edges that would close a cycle', () => {
    expect(wouldCycle(index, 1, 4)).toBe(true);
    expect(wouldCycle(index, 3, 3)).toBe(true);
    expect(wouldCycle(index, 4, 1)).toBe(false);
    expect(wouldCycle(index, 6, 1)).toBe(false);
  });

  it('builds the neighborhood of a focus tag', () => {
    expect(neighborhood(index, 3, 1, true)).toEqual([4, 1, 3, 5, 2]);
    expect(neighborhood(index, 3, 1, false)).toEqual([4, 1, 3, 2]);
    expect(neighborhood(index, 1, 1, true)).toEqual([1, 3]);
  });

  it('builds a capped overview without unrelated tags', () => {
    expect(overview(index, 100, true)).toEqual({ ids: [4, 1, 3, 5, 2], hidden: 1 });
    expect(overview(index, 2, false)).toEqual({ ids: [1, 2], hidden: 4 });
  });

  it('lists the edges of a view', () => {
    const { edges, rank } = viewEdges(index, [1, 2, 3, 5], true);
    expect(edges).toEqual([
      { from: 2, to: 3, kind: 'parent', primary: true },
      { from: 1, to: 3, kind: 'parent', primary: false },
      { from: 3, to: 5, kind: 'component', primary: false },
    ]);
    expect(rank).toHaveLength(3);
    expect(viewEdges(index, [1, 2, 3, 5], false).edges).toHaveLength(2);
  });

  it('searches names and aliases and keeps the ancestors visible', () => {
    expect(searchTags(index, '  ')).toBeNull();
    const result = searchTags(index, 'JUMP');
    expect([...(result?.matches ?? [])]).toEqual([3]);
    expect([...(result?.visible ?? [])].sort()).toEqual([1, 2, 3]);
  });

  it('builds tree rows from the expanded keys', () => {
    expect(treeRows(index, new Set()).map((r) => r.key)).toEqual(['/1', '/6', '/5', '/2']);
    const rows = treeRows(index, new Set(['/1', '/1/3']));
    expect(rows.map((r) => r.key)).toEqual(['/1', '/1/3', '/1/3/4', '/6', '/5', '/2']);
    expect(rows[1]).toEqual({ key: '/1/3', tagId: 3, depth: 1, childCount: 1, expanded: true });
    const filtered = treeRows(index, new Set(), new Set([1, 3]));
    expect(filtered.map((r) => r.key)).toEqual(['/1', '/1/3']);
  });

  it('finds the keys that reveal a tag', () => {
    expect(pathKeys(index, 4)).toEqual(['/2', '/2/3']);
    expect(pathKeys(index, 1)).toEqual([]);
  });
});

describe('layoutGraph', () => {
  const width = () => 80;

  it('puts children in the column to the right of their parents', () => {
    const layout = layoutGraph(
      [1, 2, 3, 4],
      [
        { from: 1, to: 3 },
        { from: 2, to: 3 },
        { from: 3, to: 4 },
      ],
      width,
    );
    const at = (id: number) => layout.nodes.get(id)!;
    expect([1, 2, 3, 4].map((id) => at(id).layer)).toEqual([0, 0, 1, 2]);
    expect(at(3).x).toBeGreaterThan(at(1).x + at(1).w);
    expect(Math.abs(at(1).y - at(2).y)).toBeGreaterThanOrEqual(NODE_HEIGHT + ROW_GAP);
    expect(Math.min(...[1, 2, 3, 4].map((id) => at(id).y))).toBe(0);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThanOrEqual(2 * NODE_HEIGHT + ROW_GAP);
  });

  it('moves a root next to its only child and survives a cycle', () => {
    const layout = layoutGraph(
      [1, 2, 3, 4],
      [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
        { from: 4, to: 3 },
      ],
      width,
    );
    expect(layout.nodes.get(4)?.layer).toBe(1);
    const cyclic = layoutGraph(
      [1, 2],
      [
        { from: 1, to: 2 },
        { from: 2, to: 1 },
      ],
      width,
    );
    expect(cyclic.nodes.size).toBe(2);
    expect(layoutGraph([], [], width)).toEqual({ nodes: new Map(), width: 0, height: 0 });
  });
});
