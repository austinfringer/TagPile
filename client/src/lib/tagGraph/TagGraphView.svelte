<script lang="ts">
  import { tagColorSpec } from '../tagColors';
  import { layoutGraph, type LayoutNode } from './layout';
  import { viewEdges, type TagGraphIndex } from './model';

  let {
    index,
    ids,
    selectedId,
    focusId,
    matches = null,
    showComponents,
    canEdit,
    onSelect,
    onFocus,
    onLink,
  }: {
    index: TagGraphIndex;
    /** The tags to draw. */
    ids: readonly number[];
    selectedId: number | null;
    focusId: number | null;
    /** When set, tags outside this set are dimmed. */
    matches?: ReadonlySet<number> | null;
    showComponents: boolean;
    canEdit: boolean;
    onSelect: (tagId: number) => void;
    onFocus: (tagId: number) => void;
    /** The user dragged `sourceId` onto `targetId` and released at the client point. */
    onLink: (sourceId: number, targetId: number, x: number, y: number) => void;
  } = $props();

  const MAX_LABEL = 28;
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 2.5;
  const PAD = 32;
  const DRAG_THRESHOLD = 5;

  const labelOf = (name: string) =>
    name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name;
  const widthOf = (id: number) => labelOf(index.nodes.get(id)?.name ?? '').length * 7 + 22;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  const view = $derived(viewEdges(index, ids, showComponents));
  const layout = $derived(layoutGraph(ids, view.rank, widthOf));

  const placed = $derived(
    ids.flatMap((id) => {
      const box = layout.nodes.get(id);
      const tag = index.nodes.get(id);
      return box && tag
        ? [{ box, tag, spec: tagColorSpec(tag.color), label: labelOf(tag.name) }]
        : [];
    }),
  );

  function edgePath(a: LayoutNode, b: LayoutNode): string {
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const y2 = b.y + b.h / 2;
    if (b.x > x1) {
      const dx = (b.x - x1) / 2;
      return `M${x1} ${y1} C${x1 + dx} ${y1} ${b.x - dx} ${y2} ${b.x} ${y2}`;
    }
    // Same column or to the left: loop around the right sides.
    const x2 = b.x + b.w;
    const out = Math.max(x1, x2) + 36;
    return `M${x1} ${y1} C${out} ${y1} ${out} ${y2} ${x2} ${y2}`;
  }

  const paths = $derived(
    view.edges.flatMap((edge) => {
      const a = layout.nodes.get(edge.from);
      const b = layout.nodes.get(edge.to);
      return a && b ? [{ ...edge, d: edgePath(a, b) }] : [];
    }),
  );

  // ---- Pan and zoom ----------------------------------------------------------

  let wrap = $state<HTMLDivElement>();
  let size = $state({ w: 800, h: 600 });
  let tx = $state(0);
  let ty = $state(0);
  let zoom = $state(1);

  $effect(() => {
    const el = wrap;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      size = { w: el.clientWidth, h: el.clientHeight };
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  /** Shows the full graph. When it does not fit, centers the focus tag. */
  function fit() {
    const scale = Math.min(
      1.25,
      (size.w - 2 * PAD) / Math.max(layout.width, 1),
      (size.h - 2 * PAD) / Math.max(layout.height, 1),
    );
    const next = clamp(scale, 0.5, 1.25);
    const anchor = focusId === null ? undefined : layout.nodes.get(focusId);
    zoom = next;
    if (scale < next && anchor) {
      tx = size.w / 2 - (anchor.x + anchor.w / 2) * next;
      ty = size.h / 2 - (anchor.y + anchor.h / 2) * next;
    } else if (scale < next) {
      tx = PAD;
      ty = PAD;
    } else {
      tx = (size.w - layout.width * next) / 2;
      ty = (size.h - layout.height * next) / 2;
    }
  }

  $effect(fit);

  function onWheel(event: WheelEvent) {
    if (!wrap) return;
    event.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const next = clamp(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), MIN_ZOOM, MAX_ZOOM);
    tx = px - ((px - tx) * next) / zoom;
    ty = py - ((py - ty) * next) / zoom;
    zoom = next;
  }

  // ---- Pointer: pan the background, or drag one tag onto another --------------

  let pan: { x: number; y: number; tx: number; ty: number } | null = null;
  let pending: { id: number; x: number; y: number } | null = null;
  let drag = $state<{ id: number; x: number; y: number } | null>(null);
  let hoverId = $state<number | null>(null);
  let suppressClick = false;

  function onBackgroundDown(event: PointerEvent) {
    if (event.button !== 0) return;
    pan = { x: event.clientX, y: event.clientY, tx, ty };
  }

  function onNodeDown(event: PointerEvent, id: number) {
    if (event.button !== 0) return;
    event.stopPropagation();
    suppressClick = false;
    if (canEdit) pending = { id, x: event.clientX, y: event.clientY };
  }

  function tagIdAt(x: number, y: number): number | null {
    const el = document.elementFromPoint?.(x, y)?.closest('[data-tag-id]');
    const id = el instanceof SVGElement ? Number(el.dataset.tagId) : Number.NaN;
    return Number.isNaN(id) ? null : id;
  }

  function onPointerMove(event: PointerEvent) {
    if (pan) {
      tx = pan.tx + event.clientX - pan.x;
      ty = pan.ty + event.clientY - pan.y;
      return;
    }
    if (!pending || !wrap) return;
    const moved = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
    if (!drag && moved < DRAG_THRESHOLD) return;
    const rect = wrap.getBoundingClientRect();
    drag = {
      id: pending.id,
      x: (event.clientX - rect.left - tx) / zoom,
      y: (event.clientY - rect.top - ty) / zoom,
    };
    const over = tagIdAt(event.clientX, event.clientY);
    hoverId = over === pending.id ? null : over;
  }

  function onPointerUp(event: PointerEvent) {
    pan = null;
    if (drag) {
      suppressClick = true;
      if (hoverId !== null) onLink(drag.id, hoverId, event.clientX, event.clientY);
    }
    pending = null;
    drag = null;
    hoverId = null;
  }

  function onNodeClick(id: number) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    onSelect(id);
  }

  function onNodeKeydown(event: KeyboardEvent, id: number) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (event.shiftKey) onFocus(id);
    else onSelect(id);
  }

  const dragSource = $derived(drag ? layout.nodes.get(drag.id) : undefined);
  const touchesSelected = (edge: { from: number; to: number }) =>
    selectedId !== null && (edge.from === selectedId || edge.to === selectedId);
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={onPointerUp} />

<div
  bind:this={wrap}
  class="graph"
  class:dragging={drag !== null}
  role="presentation"
  onpointerdown={onBackgroundDown}
  onwheel={onWheel}
>
  <svg width="100%" height="100%" aria-label="Tag graph">
    <defs>
      <marker
        id="tag-graph-arrow"
        viewBox="0 0 8 8"
        refX="7"
        refY="4"
        markerWidth="7"
        markerHeight="7"
        orient="auto"
      >
        <path d="M0 0L8 4L0 8z" class="arrow" />
      </marker>
    </defs>
    <g transform="translate({tx} {ty}) scale({zoom})">
      {#each paths as edge (`${edge.kind}:${edge.from}:${edge.to}`)}
        <path
          class="edge {edge.kind}"
          class:primary={edge.primary}
          class:active={touchesSelected(edge)}
          d={edge.d}
          marker-end={edge.kind === 'component' ? 'url(#tag-graph-arrow)' : undefined}
        />
      {/each}
      {#if drag && dragSource}
        <line
          class="drag-line"
          x1={dragSource.x + dragSource.w / 2}
          y1={dragSource.y + dragSource.h / 2}
          x2={drag.x}
          y2={drag.y}
        />
      {/if}
      {#each placed as { box, tag, spec, label } (tag.tagId)}
        <g
          class="node"
          class:selected={tag.tagId === selectedId}
          class:focus={tag.tagId === focusId}
          class:dim={matches !== null && !matches.has(tag.tagId)}
          class:target={tag.tagId === hoverId}
          role="button"
          tabindex="0"
          aria-label={tag.name}
          aria-pressed={tag.tagId === selectedId}
          data-context="tag"
          data-tag-id={tag.tagId}
          data-tag-name={tag.name}
          transform="translate({box.x} {box.y})"
          onpointerdown={(event) => onNodeDown(event, tag.tagId)}
          onclick={() => onNodeClick(tag.tagId)}
          ondblclick={() => onFocus(tag.tagId)}
          onkeydown={(event) => onNodeKeydown(event, tag.tagId)}
        >
          <title>{tag.name} ({tag.fileCount} {tag.fileCount === 1 ? 'file' : 'files'})</title>
          <rect class="halo" x="-4" y="-4" width={box.w + 8} height={box.h + 8} rx="5" />
          <rect
            class="body"
            width={box.w}
            height={box.h}
            rx="3"
            fill={spec.fill}
            stroke={spec.border}
          />
          {#if tag.isCategory}
            <rect class="category-mark" width="4" height={box.h} rx="2" fill={spec.border} />
          {/if}
          <text x={box.w / 2} y={box.h / 2} fill={spec.text}>{label}</text>
        </g>
      {/each}
    </g>
  </svg>

  {#if placed.length === 0}
    <p class="empty">No tag relationships to show. Select a tag, or add a parent to a tag.</p>
  {/if}

  <div class="overlay">
    <div class="legend" aria-hidden="true">
      <span><i class="swatch parent"></i>parent → child</span>
      <span><i class="swatch component"></i>tag → component</span>
    </div>
    <button type="button" class="fit" onpointerdown={(e) => e.stopPropagation()} onclick={fit}>
      Fit
    </button>
  </div>
</div>

<style lang="scss">
  @use '../../styles/variables' as *;

  .graph {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background:
      radial-gradient(circle, rgb(255 255 255 / 5%) 1px, transparent 1px) 0 0 / 24px 24px,
      $color-shell-bg;
    cursor: grab;
    user-select: none;
    touch-action: none;

    &.dragging {
      cursor: crosshair;
    }
  }

  svg {
    display: block;
  }

  .edge {
    fill: none;
    stroke: $color-border;
    stroke-width: 1.5;

    &.primary {
      stroke: $color-text-dim;
      stroke-width: 2;
    }

    &.component {
      stroke: $color-jobs-accent;
      stroke-dasharray: 5 4;
      opacity: 0.7;
    }

    &.active {
      stroke: $color-text-strong;
      opacity: 1;
    }

    &.component.active {
      stroke: $color-jobs-accent;
    }
  }

  .arrow {
    fill: $color-jobs-accent;
  }

  .drag-line {
    stroke: $color-jobs-accent;
    stroke-width: 2;
    stroke-dasharray: 4 4;
    pointer-events: none;
  }

  .node {
    cursor: pointer;
    outline: none;

    text {
      font-size: 12px;
      font-weight: 500;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
    }

    .halo {
      fill: none;
      stroke: transparent;
      stroke-width: 2;
    }

    &:hover .halo,
    &:focus-visible .halo {
      stroke: $color-text-dim;
    }

    &.focus .halo {
      stroke: $color-text-inactive;
      stroke-dasharray: 3 3;
    }

    &.selected .halo,
    &.target .halo {
      stroke: $color-jobs-accent;
      stroke-dasharray: none;
    }

    &.target .halo {
      fill: rgb(242 178 74 / 20%);
    }

    &.dim {
      opacity: 0.3;
    }
  }

  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    padding: 24px;
    font-size: 13px;
    color: $color-text-dim;
    text-align: center;
    pointer-events: none;
  }

  .overlay {
    position: absolute;
    right: 12px;
    bottom: 12px;
    left: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    pointer-events: none;
  }

  .legend {
    display: flex;
    gap: 16px;
    font-size: 11px;
    color: $color-text-dim;

    span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
  }

  .swatch {
    display: inline-block;
    width: 22px;
    height: 0;
    border-top: 2px solid $color-text-dim;

    &.component {
      border-top: 2px dashed $color-jobs-accent;
    }
  }

  .fit {
    padding: 6px 12px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    color: $color-text-inactive;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
    cursor: pointer;
    pointer-events: auto;

    &:hover {
      color: $color-text-strong;
    }
  }
</style>
