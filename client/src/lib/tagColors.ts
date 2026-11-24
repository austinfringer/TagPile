/** Color math for the tag display. "Luminance" here is the HSL lightness channel: the
 *  fill keeps the chosen color, the border steps lightness by 20 points away from the
 *  middle (up for dark colors, down for light colors), and the text is white on dark
 *  colors or the same hue/saturation at 12% lightness on light colors. */

export const DEFAULT_TAG_COLOR = '#5d5d6a';

export interface TagColorSpec {
  fill: string;
  border: string;
  text: string;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** Parses `#rgb` and `#rrggbb` (with or without the hash). Returns null for anything else. */
export function parseHexColor(color: string): Rgb | null {
  const hex = color.trim().replace(/^#/, '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const [rn, gn, bn] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  return {
    r: Math.round((rn + m) * 255),
    g: Math.round((gn + m) * 255),
    b: Math.round((bn + m) * 255),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

const clampLightness = (l: number) => Math.min(1, Math.max(0, l));

const LIGHTNESS_STEP = 0.2;
const DARK_TEXT_LIGHTNESS = 0.12;

/** The fill, border, and text colors of a tag chip. Invalid or missing colors fall back
 *  to `DEFAULT_TAG_COLOR`. */
export function tagColorSpec(color: string | null | undefined): TagColorSpec {
  const parsed = color ? parseHexColor(color) : null;
  const base = parsed ?? (parseHexColor(DEFAULT_TAG_COLOR) as Rgb);
  const hsl = rgbToHsl(base);
  const light = hsl.l >= 0.5;
  return {
    fill: rgbToHex(base),
    border: rgbToHex(
      hslToRgb({ ...hsl, l: clampLightness(hsl.l + (light ? -LIGHTNESS_STEP : LIGHTNESS_STEP)) }),
    ),
    text: light ? rgbToHex(hslToRgb({ ...hsl, l: DARK_TEXT_LIGHTNESS })) : '#ffffff',
  };
}
