import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPreviews, ensurePreviews, previewSource } from './previews.svelte';

/** Stubs global fetch for the batch endpoint: `resolver` maps each requested chunk to the
 *  file ids that have a preview; the rest are answered without one. All previews are a fixed
 *  webp payload. */
function stubFetch(resolver: (ids: number[]) => number[] | Response) {
  const calls: number[][] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/api/previews');
    expect(init?.method).toBe('POST');
    const { ids } = JSON.parse(String(init?.body)) as { ids: number[] };
    calls.push(ids);
    const resolved = resolver(ids);
    if (resolved instanceof Response) return resolved;
    return new Response(
      JSON.stringify({
        previews: resolved.map((fileId) => ({
          fileId,
          type: 'image',
          mime: 'image/webp',
          data: 'UklGRiQAAABX',
        })),
        notFound: [],
      }),
      { status: 200 },
    );
  });
  return calls;
}

describe('preview store', () => {
  afterEach(() => {
    clearPreviews();
    vi.unstubAllGlobals();
  });

  it('reports null before any fetch and resolves ids in one batch request', async () => {
    const calls = stubFetch((ids) => ids.filter((id) => id !== 7));
    expect(previewSource(5)).toBeNull();

    ensurePreviews([5, 7]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([5, 7]);

    await vi.waitFor(() => {
      expect(previewSource(5)).toBe('data:image/webp;base64,UklGRiQAAABX');
    });
    expect(previewSource(7)).toBeNull();
  });

  it('serves cached ids without another request', async () => {
    const calls = stubFetch((ids) => ids);
    ensurePreviews([5]);
    await vi.waitFor(() => expect(previewSource(5)).not.toBeNull());

    ensurePreviews([5]);
    expect(calls).toHaveLength(1);
  });

  it('requests each id once when several callers ask at the same time', async () => {
    const calls = stubFetch((ids) => ids);
    ensurePreviews([5, 6]);
    ensurePreviews([6, 7]);
    // 6 was already in flight, so the second call only requests 7.
    expect(calls).toEqual([[5, 6], [7]]);
    await vi.waitFor(() => expect(previewSource(6)).not.toBeNull());
    await vi.waitFor(() => expect(previewSource(7)).not.toBeNull());
  });

  it('splits a large request into batches of 500', async () => {
    const calls = stubFetch((ids) => ids);
    ensurePreviews(Array.from({ length: 501 }, (_, i) => i + 1));
    expect(calls.map((chunk) => chunk.length)).toEqual([500]);
    await vi.waitFor(() => expect(calls.map((chunk) => chunk.length)).toEqual([500, 1]));
  });

  it('falls back to null for every requested id when the request fails', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
    ensurePreviews([5, 6]);

    await vi.waitFor(() => {
      expect(previewSource(5)).toBeNull();
    });
    expect(previewSource(6)).toBeNull();
  });
});
