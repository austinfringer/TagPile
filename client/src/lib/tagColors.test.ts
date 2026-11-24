import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAG_COLOR,
  hslToRgb,
  parseHexColor,
  rgbToHex,
  rgbToHsl,
  tagColorSpec,
} from './tagColors';

describe('parseHexColor', () => {
  it('parses 6- and 3-digit hex, with or without the hash', () => {
    expect(parseHexColor('#10b981')).toEqual({ r: 16, g: 185, b: 129 });
    expect(parseHexColor('f0c')).toEqual({ r: 255, g: 0, b: 204 });
    expect(parseHexColor('ffffff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('rejects malformed colors', () => {
    expect(parseHexColor('')).toBeNull();
    expect(parseHexColor('#12')).toBeNull();
    expect(parseHexColor('#zzzzzz')).toBeNull();
    expect(parseHexColor('red')).toBeNull();
  });
});

describe('rgb/hsl conversion', () => {
  it('round-trips through hex', () => {
    for (const hex of ['#1416b2', '#ec4899', '#10b981', '#5d5d6a', '#000000', '#ffffff']) {
      const rgb = parseHexColor(hex);
      expect(rgb).not.toBeNull();
      expect(rgbToHex(hslToRgb(rgbToHsl(rgb!)))).toBe(hex);
    }
  });

  it('computes the known lightness of sample colors', () => {
    // hsl lightness of #1416b2 is ~0.388, of #ec4899 ~0.604
    expect(rgbToHsl(parseHexColor('#1416b2')!).l).toBeCloseTo(0.388, 2);
    expect(rgbToHsl(parseHexColor('#ec4899')!).l).toBeCloseTo(0.604, 2);
  });
});

describe('tagColorSpec', () => {
  it('keeps the chosen color as the fill', () => {
    expect(tagColorSpec('#1416b2').fill).toBe('#1416b2');
  });

  it('dark colors get a brighter border and white text', () => {
    const spec = tagColorSpec('#1416b2'); // lightness ~0.388
    expect(spec.text).toBe('#ffffff');
    expect(rgbToHsl(parseHexColor(spec.border)!).l).toBeCloseTo(0.588, 2);
  });

  it('light colors get a darker border and dark text in the same hue', () => {
    const spec = tagColorSpec('#ec4899'); // lightness ~0.604
    const border = rgbToHsl(parseHexColor(spec.border)!);
    const text = parseHexColor(spec.text)!;
    expect(border.l).toBeCloseTo(0.404, 2);
    expect(text).not.toBe('#ffffff');
    expect(rgbToHsl(text).l).toBeCloseTo(0.12, 2);
    expect(rgbToHsl(text).h).toBeCloseTo(rgbToHsl(parseHexColor('#ec4899')!).h, 0);
  });

  it('a color at 50% lightness is treated as light', () => {
    const spec = tagColorSpec('#808080'); // lightness 128/255 ≈ 0.502
    expect(spec.text).not.toBe('#ffffff');
    expect(rgbToHsl(parseHexColor(spec.border)!).l).toBeCloseTo(0.302, 2);
  });

  it('clamps the border lightness at the ends of the scale', () => {
    // 10/255 + 0.2 ≈ 0.239 and 250/255 - 0.2 ≈ 0.780
    expect(rgbToHsl(parseHexColor(tagColorSpec('#0a0a0a').border)!).l).toBeCloseTo(0.239, 2);
    expect(rgbToHsl(parseHexColor(tagColorSpec('#fafafa').border)!).l).toBeCloseTo(0.78, 2);
  });

  it('falls back to the default color for missing or invalid input', () => {
    for (const input of [null, undefined, 'nope']) {
      const fallback = tagColorSpec(input);
      expect(fallback.fill).toBe(DEFAULT_TAG_COLOR);
      expect(fallback).toEqual(tagColorSpec(DEFAULT_TAG_COLOR));
    }
  });
});
