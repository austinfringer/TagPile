import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../db/errors.ts';
import { SearchSyntaxError } from '../db/search_operations.ts';
import { parseQueryInt, sendError } from './util.ts';

function fakeRes() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, out };
}

describe('sendError', () => {
  it.each([
    [new NotFoundError('a'), 404],
    [new ConflictError('b'), 409],
    [new Error('UNIQUE constraint failed: aliases.text'), 409],
    [new ValidationError('c'), 400],
    [new SearchSyntaxError('d'), 400],
  ])('maps %s to %i', (err, status) => {
    const { res, out } = fakeRes();
    sendError(res, err, { opIndex: 1 });
    expect(out).toEqual({ status, body: { error: err.message, opIndex: 1 } });
  });

  it('rethrows an unknown error', () => {
    const { res } = fakeRes();
    expect(() => sendError(res, new Error('boom'))).toThrow('boom');
  });
});

describe('parseQueryInt', () => {
  it('reads, defaults, clamps and rejects', () => {
    expect(parseQueryInt(undefined, 10, 50)).toBe(10);
    expect(parseQueryInt('7', 10, 50)).toBe(7);
    expect(parseQueryInt('99', 10, 50)).toBe(50);
    expect(parseQueryInt('-1', 10)).toBeNull();
    expect(parseQueryInt('1.5', 10)).toBeNull();
    expect(parseQueryInt(['1'], 10)).toBeNull();
  });
});
