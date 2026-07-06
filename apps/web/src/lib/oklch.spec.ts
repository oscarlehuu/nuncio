import { describe, it, expect } from 'vitest';
import {
  contrastRatio,
  oklchToRgb,
  parseHex,
  rgbToOklch,
} from './oklch';

describe('oklch conversions', () => {
  it('parses 3- and 6-digit hex', () => {
    expect(parseHex('#fff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseHex('000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHex('nope')).toBeNull();
  });

  it('round-trips a color through OKLCH within tolerance', () => {
    const rgb = { r: 0.2, g: 0.6, b: 0.9 };
    const back = oklchToRgb(rgbToOklch(rgb));
    expect(back.r).toBeCloseTo(rgb.r, 2);
    expect(back.g).toBeCloseTo(rgb.g, 2);
    expect(back.b).toBeCloseTo(rgb.b, 2);
  });

  it('gives white ~1.0 lightness and black ~0', () => {
    expect(rgbToOklch({ r: 1, g: 1, b: 1 }).l).toBeCloseTo(1, 2);
    expect(rgbToOklch({ r: 0, g: 0, b: 0 }).l).toBeCloseTo(0, 2);
  });

  it('computes WCAG contrast (black on white ~21)', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 })).toBeCloseTo(21, 0);
  });
});
