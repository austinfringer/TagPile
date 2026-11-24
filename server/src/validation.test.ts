import { describe, expect, it } from 'vitest';
import { isValidPassword } from './validation.ts';

describe('isValidPassword', () => {
  it('needs at least 8 characters', () => {
    expect(isValidPassword('1234567')).toBe(false);
    expect(isValidPassword('12345678')).toBe(true);
  });

  it('accepts spaces and non-ASCII characters', () => {
    expect(isValidPassword('correct horse battery')).toBe(true);
    expect(isValidPassword('пароль-пароль')).toBe(true);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(isValidPassword('😀😀😀😀')).toBe(false);
  });

  it('allows at most 72 UTF-8 bytes', () => {
    expect(isValidPassword('a'.repeat(72))).toBe(true);
    expect(isValidPassword('a'.repeat(73))).toBe(false);
    expect(isValidPassword('é'.repeat(37))).toBe(false);
  });
});
