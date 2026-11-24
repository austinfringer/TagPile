import { describe, expect, it } from 'vitest';
import {
  applyWikiLinkCompletion,
  buildWikiTagLookup,
  findActiveWikiLink,
  getTextareaCaretRect,
  parseWikiMarkdown,
  resolveWikiTagLink,
} from './wiki';

const TAGS = [
  { tagId: 5, name: 'Art', color: '#1416b2' },
  { tagId: 6, name: 'Landscape', color: '#10b981' },
  { tagId: 7, name: 'Moody', color: '#ec4899' },
];

const EXTRA_ALIASES = [{ tagId: 6, text: 'land' }];

describe('wiki helpers', () => {
  const lookup = buildWikiTagLookup(TAGS, EXTRA_ALIASES);

  describe('resolveWikiTagLink', () => {
    it('resolves [[tagId|label]] and [[tagId]]', () => {
      expect(resolveWikiTagLink('6|Mountain View', lookup)).toEqual({
        tagId: 6,
        label: 'Mountain View',
        color: '#10b981',
      });
      expect(resolveWikiTagLink('6', lookup)).toEqual({
        tagId: 6,
        label: 'Landscape',
        color: '#10b981',
      });
    });

    it('resolves [[alias]] by primary or secondary alias case-insensitively', () => {
      expect(resolveWikiTagLink('landscape', lookup)).toEqual({
        tagId: 6,
        label: 'landscape',
        color: '#10b981',
      });
      expect(resolveWikiTagLink('land', lookup)).toEqual({
        tagId: 6,
        label: 'land',
        color: '#10b981',
      });
    });

    it('returns tagId null for an unknown alias', () => {
      expect(resolveWikiTagLink('NonExistent', lookup)).toEqual({
        tagId: null,
        label: 'NonExistent',
        color: null,
      });
    });
  });

  describe('parseWikiMarkdown', () => {
    it('parses headings, paragraphs, bold, italic, code, lists, and [[tag]] links', () => {
      const md = [
        '# Overview',
        '',
        'A **bold** and *italic* note about [[6|Landscape]] and [[Art]] with `code`.',
        '',
        '- First item with [[land]]',
        '- Second item',
      ].join('\n');

      const blocks = parseWikiMarkdown(md, lookup);
      expect(blocks).toHaveLength(3);
      expect(blocks[0]).toEqual({
        type: 'heading',
        level: 1,
        inlines: [{ type: 'text', text: 'Overview' }],
      });
      expect(blocks[1]).toEqual({
        type: 'paragraph',
        inlines: [
          { type: 'text', text: 'A ' },
          { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
          { type: 'text', text: ' and ' },
          { type: 'em', children: [{ type: 'text', text: 'italic' }] },
          { type: 'text', text: ' note about ' },
          {
            type: 'tag_link',
            raw: '6|Landscape',
            tagId: 6,
            label: 'Landscape',
            color: '#10b981',
          },
          { type: 'text', text: ' and ' },
          {
            type: 'tag_link',
            raw: 'Art',
            tagId: 5,
            label: 'Art',
            color: '#1416b2',
          },
          { type: 'text', text: ' with ' },
          { type: 'code', code: 'code' },
          { type: 'text', text: '.' },
        ],
      });
      expect(blocks[2]).toEqual({
        type: 'unordered_list',
        items: [
          [
            { type: 'text', text: 'First item with ' },
            { type: 'tag_link', raw: 'land', tagId: 6, label: 'land', color: '#10b981' },
          ],
          [{ type: 'text', text: 'Second item' }],
        ],
      });
    });

    it('rejects unsafe javascript: links as plain text while keeping https:// links', () => {
      const blocks = parseWikiMarkdown(
        'Check [safe](https://example.com) and [bad](javascript:alert(1)).',
        lookup,
      );
      expect(blocks[0]).toEqual({
        type: 'paragraph',
        inlines: [
          { type: 'text', text: 'Check ' },
          {
            type: 'link',
            label: [{ type: 'text', text: 'safe' }],
            href: 'https://example.com',
          },
          { type: 'text', text: ' and [bad](javascript:alert(1)).' },
        ],
      });
    });

    it('rejects protocol-relative links to another host but keeps same-site paths', () => {
      const text = (href: string) =>
        parseWikiMarkdown(`[x](${href})`, lookup)[0] as { inlines: unknown[] };
      expect(text('//evil.example/path').inlines).toEqual([
        { type: 'text', text: '[x](//evil.example/path)' },
      ]);
      expect(text('/\\evil.example').inlines).toEqual([
        { type: 'text', text: '[x](/\\evil.example)' },
      ]);
      expect(text('/tags/3').inlines).toEqual([
        { type: 'link', label: [{ type: 'text', text: 'x' }], href: '/tags/3' },
      ]);
    });
  });

  describe('findActiveWikiLink and applyWikiLinkCompletion', () => {
    it('detects active [[query at the cursor and replaces with [[tagId|alias]]', () => {
      const text = 'See [[land for details';
      const cursor = 'See [[land'.length;
      const active = findActiveWikiLink(text, cursor);
      expect(active).toEqual({
        start: 4,
        end: 10,
        query: 'land',
      });

      const applied = applyWikiLinkCompletion(text, active!, 6, 'Landscape');
      expect(applied.text).toBe('See [[6|Landscape]] for details');
      expect(applied.cursor).toBe('See [[6|Landscape]]'.length);
    });

    it('consumes trailing ]] when the brackets were already closed', () => {
      const text = 'See [[land]]';
      const cursor = 'See [[land'.length;
      const active = findActiveWikiLink(text, cursor);
      expect(active).toEqual({
        start: 4,
        end: 12,
        query: 'land',
      });

      const applied = applyWikiLinkCompletion(text, active!, 6, 'land');
      expect(applied.text).toBe('See [[6|land]]');
    });

    it('returns null outside [[ or after ]] or after |', () => {
      expect(findActiveWikiLink('plain text', 5)).toBeNull();
      expect(findActiveWikiLink('[[6|Landscape]] after', 18)).toBeNull();
      expect(findActiveWikiLink('[[6|custom', 10)).toBeNull();
    });
  });

  describe('getTextareaCaretRect', () => {
    it('returns null when the textarea is not in the document', () => {
      const textarea = document.createElement('textarea');
      expect(getTextareaCaretRect(textarea, 0)).toBeNull();
    });

    it('measures a rendered textarea and removes its mirror afterwards', () => {
      const textarea = document.createElement('textarea');
      textarea.value = 'line one\nline two';
      document.body.appendChild(textarea);
      try {
        const rect = getTextareaCaretRect(textarea, 10);
        expect(rect).not.toBeNull();
        expect(Number.isFinite(rect!.top)).toBe(true);
        expect(Number.isFinite(rect!.left)).toBe(true);
        expect(rect!.height).toBeGreaterThan(0);
      } finally {
        textarea.remove();
      }
      expect(document.body.querySelector('div[aria-hidden="true"]')).toBeNull();
    });

    it('clamps caret positions outside the text', () => {
      const textarea = document.createElement('textarea');
      textarea.value = 'abc';
      document.body.appendChild(textarea);
      try {
        expect(getTextareaCaretRect(textarea, -5)).not.toBeNull();
        expect(getTextareaCaretRect(textarea, 500)).not.toBeNull();
      } finally {
        textarea.remove();
      }
    });
  });
});
