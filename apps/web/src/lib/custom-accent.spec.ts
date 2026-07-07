import { describe, it, expect } from 'vitest';
import { deriveCustomAccent, CUSTOM_ACCENT_VARS } from './custom-accent';
import { contrastRatio, oklchToRgb, parseHex } from './oklch';

/** Parse the L/C/H out of an `oklch(l c h)` string the util emits. */
function parseOklchStr(s: string): { l: number; c: number; h: number } {
  const m = s.match(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/);
  if (!m) throw new Error(`not oklch: ${s}`);
  return { l: +m[1], c: +m[2], h: +m[3] };
}

const WHITE = parseHex('#ffffff')!;

describe('deriveCustomAccent', () => {
  it('returns null for invalid hex', () => {
    expect(deriveCustomAccent('not-a-color')).toBeNull();
  });

  it('emits the full token set for both themes', () => {
    const tokens = deriveCustomAccent('#3b82f6')!;
    for (const name of CUSTOM_ACCENT_VARS) {
      expect(tokens.light[name], `light ${name}`).toBeTruthy();
      expect(tokens.dark[name], `dark ${name}`).toBeTruthy();
    }
  });

  it('light-mode --primary clears WCAG AA 4.5:1 as text on white', () => {
    // Sweep a range of hues incl. yellows/greens that fight contrast the most.
    for (const hex of ['#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#06b6d4', '#f97316']) {
      const tokens = deriveCustomAccent(hex)!;
      const { l, c, h } = parseOklchStr(tokens.light['--primary']);
      const rgb = oklchToRgb({ l, c, h });
      const ratio = contrastRatio(rgb, WHITE);
      expect(ratio, `${hex} -> primary contrast on white`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the vivid ring hue distinct from the darkened text primary', () => {
    const tokens = deriveCustomAccent('#22c55e')!;
    const ring = parseOklchStr(tokens.light['--ring']);
    const primary = parseOklchStr(tokens.light['--primary']);
    expect(ring.l).toBeGreaterThan(primary.l);
  });
});
