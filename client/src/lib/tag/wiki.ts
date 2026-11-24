export interface WikiTagInfo {
  tagId: number;
  name: string;
  color: string | null;
}

export interface WikiTagLookup {
  byId: ReadonlyMap<number, WikiTagInfo>;
  byAlias: ReadonlyMap<string, WikiTagInfo>;
}

export type WikiInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: WikiInline[] }
  | { type: 'em'; children: WikiInline[] }
  | { type: 'del'; children: WikiInline[] }
  | { type: 'code'; code: string }
  | { type: 'link'; label: WikiInline[]; href: string }
  | {
      type: 'tag_link';
      raw: string;
      tagId: number | null;
      label: string;
      color: string | null;
    }
  | { type: 'br' };

export type WikiBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: WikiInline[] }
  | { type: 'paragraph'; inlines: WikiInline[] }
  | { type: 'code_block'; lang: string; code: string }
  | { type: 'blockquote'; inlines: WikiInline[] }
  | { type: 'unordered_list'; items: WikiInline[][] }
  | { type: 'ordered_list'; items: WikiInline[][] }
  | { type: 'hr' };

export function buildWikiTagLookup(
  tags: Iterable<WikiTagInfo>,
  extraAliases: Iterable<{ tagId: number; text: string }> = [],
): WikiTagLookup {
  const byId = new Map<number, WikiTagInfo>();
  const byAlias = new Map<string, WikiTagInfo>();
  for (const tag of tags) {
    byId.set(tag.tagId, tag);
    byAlias.set(tag.name.toLowerCase(), tag);
  }
  for (const alias of extraAliases) {
    const info = byId.get(alias.tagId);
    if (info) byAlias.set(alias.text.toLowerCase(), info);
  }
  return { byId, byAlias };
}

export function resolveWikiTagLink(
  rawInner: string,
  lookup: WikiTagLookup,
): { tagId: number | null; label: string; color: string | null } {
  const pipeIdx = rawInner.indexOf('|');
  const targetPart = pipeIdx >= 0 ? rawInner.slice(0, pipeIdx) : rawInner;
  const labelPart = pipeIdx >= 0 ? rawInner.slice(pipeIdx + 1) : '';
  const target = targetPart.trim();
  const customLabel = labelPart.trim();

  if (/^[1-9]\d*$/.test(target)) {
    const id = Number(target);
    const info = lookup.byId.get(id);
    if (info) {
      return {
        tagId: id,
        label: customLabel || info.name,
        color: info.color,
      };
    }
    const aliasMatch = lookup.byAlias.get(target.toLowerCase());
    if (aliasMatch) {
      return {
        tagId: aliasMatch.tagId,
        label: customLabel || aliasMatch.name,
        color: aliasMatch.color,
      };
    }
    return {
      tagId: id,
      label: customLabel || `#${id}`,
      color: null,
    };
  }

  const match = lookup.byAlias.get(target.toLowerCase());
  if (match) {
    return {
      tagId: match.tagId,
      label: customLabel || target || match.name,
      color: match.color,
    };
  }

  return {
    tagId: null,
    label: customLabel || target,
    color: null,
  };
}

function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  // A browser reads `//host` and `/\host` as a link to another host.
  if (/^\/[/\\]/.test(trimmed)) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return true;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

const INLINE_TOKEN_RE =
  /\[\[([^\][\n]+)\]\]|`([^`\n]+)`|\[([^\][\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;

export function parseWikiInlines(text: string, lookup: WikiTagLookup): WikiInline[] {
  const nodes: WikiInline[] = [];
  const pushText = (chunk: string) => {
    if (!chunk) return;
    const prev = nodes[nodes.length - 1];
    if (prev?.type === 'text') prev.text += chunk;
    else nodes.push({ type: 'text', text: chunk });
  };

  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_TOKEN_RE)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      pushText(text.slice(lastIndex, idx));
    }
    const [
      full,
      wikiInner,
      codeText,
      linkText,
      linkHref,
      boldStar,
      boldUnder,
      strikeText,
      emStar,
      emUnder,
    ] = match;

    if (wikiInner !== undefined) {
      const resolved = resolveWikiTagLink(wikiInner, lookup);
      nodes.push({
        type: 'tag_link',
        raw: wikiInner,
        tagId: resolved.tagId,
        label: resolved.label,
        color: resolved.color,
      });
    } else if (codeText !== undefined) {
      nodes.push({ type: 'code', code: codeText });
    } else if (linkText !== undefined && linkHref !== undefined) {
      if (isSafeHref(linkHref)) {
        nodes.push({
          type: 'link',
          label: parseWikiInlines(linkText, lookup),
          href: linkHref.trim(),
        });
      } else {
        pushText(full);
      }
    } else if (boldStar !== undefined || boldUnder !== undefined) {
      nodes.push({
        type: 'strong',
        children: parseWikiInlines((boldStar ?? boldUnder)!, lookup),
      });
    } else if (strikeText !== undefined) {
      nodes.push({
        type: 'del',
        children: parseWikiInlines(strikeText, lookup),
      });
    } else if (emStar !== undefined || emUnder !== undefined) {
      nodes.push({
        type: 'em',
        children: parseWikiInlines((emStar ?? emUnder)!, lookup),
      });
    }
    lastIndex = idx + full.length;
  }

  if (lastIndex < text.length) {
    pushText(text.slice(lastIndex));
  }
  return nodes;
}

function parseLinesWithBreaks(lines: string[], lookup: WikiTagLookup): WikiInline[] {
  const result: WikiInline[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) result.push({ type: 'br' });
    result.push(...parseWikiInlines(lines[i]!, lookup));
  }
  return result;
}

export function parseWikiMarkdown(source: string, lookup: WikiTagLookup): WikiBlock[] {
  const blocks: WikiBlock[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fenceMatch = /^```(\S*)\s*$/.exec(line.trim());
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? '';
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: 'code_block', lang, code: codeLines.join('\n') });
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({
        type: 'heading',
        level,
        inlines: parseWikiInlines(headingMatch[2]!, lookup),
      });
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({
        type: 'blockquote',
        inlines: parseLinesWithBreaks(quoteLines, lookup),
      });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: WikiInline[][] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(parseWikiInlines(lines[i]!.replace(/^\s*[-*+]\s+/, ''), lookup));
        i++;
      }
      blocks.push({ type: 'unordered_list', items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: WikiInline[][] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(parseWikiInlines(lines[i]!.replace(/^\s*\d+\.\s+/, ''), lookup));
        i++;
      }
      blocks.push({ type: 'ordered_list', items });
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^```/.test(lines[i]!.trim()) &&
      !/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]!.trim()) &&
      !/^#{1,6}\s+/.test(lines[i]!) &&
      !/^>\s?/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    blocks.push({
      type: 'paragraph',
      inlines: parseLinesWithBreaks(paraLines, lookup),
    });
  }

  return blocks;
}

export interface ActiveWikiLinkRange {
  start: number;
  end: number;
  query: string;
}

/** Detects whether `cursor` in `text` sits inside an active `[[...` tag link trigger. */
export function findActiveWikiLink(text: string, cursor: number): ActiveWikiLinkRange | null {
  if (cursor < 2 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  const openIdx = before.lastIndexOf('[[');
  if (openIdx < 0) return null;

  const between = before.slice(openIdx + 2);
  if (
    between.includes(']]') ||
    between.includes('[') ||
    between.includes(']') ||
    between.includes('|') ||
    between.includes('\n') ||
    between.includes('\r')
  ) {
    return null;
  }

  const after = text.slice(cursor);
  let end = cursor;
  if (after.startsWith(']]')) {
    end = cursor + 2;
  } else if (after.startsWith(']')) {
    end = cursor + 1;
  }

  return {
    start: openIdx,
    end,
    query: between,
  };
}

/** Replaces an active `[[...` range with `[[tagId|displayAlias]]` and returns the new text and caret position. */
export function applyWikiLinkCompletion(
  text: string,
  range: ActiveWikiLinkRange,
  tagId: number,
  displayAlias: string,
): { text: string; cursor: number } {
  const token = `[[${tagId}|${displayAlias}]]`;
  const next = text.slice(0, range.start) + token + text.slice(range.end);
  return {
    text: next,
    cursor: range.start + token.length,
  };
}

export interface TextareaCaretRect {
  /** Distance in px from the textarea's own top edge to the caret, before scrolling. */
  top: number;
  /** Distance in px from the textarea's own left edge to the caret, before scrolling. */
  left: number;
  /** Height in px of the caret's line. */
  height: number;
}

const MIRROR_STYLE_PROPS = [
  'box-sizing',
  'width',
  'min-width',
  'max-width',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-weight',
  'font-stretch',
  'letter-spacing',
  'line-height',
  'text-align',
  'text-indent',
  'text-transform',
  'tab-size',
  'word-spacing',
  'overflow-wrap',
  'word-break',
] as const;

function lineHeightOf(computed: CSSStyleDeclaration): number {
  const fontSize = parseFloat(computed.fontSize) || 16;
  const raw = computed.lineHeight.trim();
  if (raw === '' || raw === 'normal') return fontSize * 1.2;
  const value = parseFloat(raw);
  return raw.endsWith('px') ? value : fontSize * value;
}

/** Measures where the caret sits inside a textarea: the text is copied into a hidden div
 *  with identical layout, a marker span marks the caret, and its offset gives the caret's
 *  coordinates relative to the textarea's own box (scroll offsets not applied). Returns
 *  null when the textarea is not rendered and there is nothing to measure. */
export function getTextareaCaretRect(
  textarea: HTMLTextAreaElement,
  position: number,
): TextareaCaretRect | null {
  if (!textarea.isConnected) return null;
  const doc = textarea.ownerDocument;
  const view = doc.defaultView;
  if (!view) return null;
  const computed = view.getComputedStyle(textarea);
  const caret = Math.min(Math.max(position, 0), textarea.value.length);

  const mirror = doc.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  for (const prop of MIRROR_STYLE_PROPS) {
    mirror.style.setProperty(prop, computed.getPropertyValue(prop));
  }
  Object.assign(mirror.style, {
    position: 'absolute',
    top: '0px',
    left: '0px',
    height: 'auto',
    visibility: 'hidden',
    whiteSpace: 'pre-wrap',
    overflow: 'hidden',
  });
  mirror.textContent = textarea.value.slice(0, caret);
  // Zero-width space keeps the marker measurable at line starts and soft wraps.
  const marker = doc.createElement('span');
  marker.textContent = '\u200B';
  mirror.appendChild(marker);

  doc.body.appendChild(mirror);
  try {
    return {
      top: marker.offsetTop,
      left: marker.offsetLeft,
      height: marker.offsetHeight || lineHeightOf(computed),
    };
  } finally {
    mirror.remove();
  }
}
