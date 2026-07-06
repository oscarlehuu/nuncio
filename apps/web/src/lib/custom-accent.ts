import {
  contrastRatio,
  formatOklch,
  oklchToRgb,
  parseHex,
  rgbToOklch,
  type Oklch,
} from './oklch';

/**
 * Derives the full accent token set from a single user-picked hex, mirroring
 * the preset recipe in index.css. Returns a flat map of CSS custom properties
 * to apply inline on <html> under `data-accent="custom"`, split by theme.
 *
 * Invariant preserved: --primary doubles as link/title TEXT color, so the
 * light-mode primary L is lowered analytically until it clears WCAG AA 4.5:1
 * on white. Rings stay vivid (UI affordance, not held to text contrast).
 */

const WHITE = { r: 1, g: 1, b: 1 };
const AA_TEXT = 4.5;

/** Vivid accent lightness — matches the preset ring band (~0.6). */
const VIVID_L = 0.6;
/** Dark-mode primary sits a hair above the ring band to clear AA on dark card. */
const DARK_PRIMARY_L = 0.62;
/** Chroma the presets carry on their vivid accent. */
const clampChroma = (c: number) => Math.min(0.19, Math.max(0.08, c));

interface DerivedTokens {
  light: Record<string, string>;
  dark: Record<string, string>;
}

/** Lower L until the color clears AA 4.5:1 as text on white, or bottom out. */
function textSafeLightness(chroma: number, hue: number): number {
  for (let l = 0.57; l >= 0.3; l -= 0.01) {
    const rgb = oklchToRgb({ l, c: chroma, h: hue });
    if (contrastRatio(rgb, WHITE) >= AA_TEXT) return Number(l.toFixed(3));
  }
  return 0.3;
}

/** Tinted-neutral builder: base L (theme's neutral) at the accent hue + chroma. */
const n = (l: number, c: number, h: number): string => formatOklch({ l, c, h });

export function deriveCustomAccent(hex: string): DerivedTokens | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const { h } = rgbToOklch(rgb);
  const chroma = clampChroma(rgbToOklch(rgb).c || 0.15);

  const vivid: Oklch = { l: VIVID_L, c: chroma, h };
  const vividStr = formatOklch(vivid);
  const fg = formatOklch({ l: 0.98, c: 0.01, h });
  const lightPrimaryL = textSafeLightness(chroma, h);
  const lightPrimary = formatOklch({ l: lightPrimaryL, c: chroma, h });
  const darkPrimary = formatOklch({ l: DARK_PRIMARY_L, c: chroma, h });

  // Neutral tint chroma: dark carries the hue at ~0.014; light scaled down hard
  // (bg 0.15x, sidebar 0.35x) or the surfaces muddy.
  const darkC = 0.014;
  const lightBgC = Number((darkC * 0.15).toFixed(4));
  const lightSideC = Number((darkC * 0.35).toFixed(4));

  return {
    light: {
      '--primary': lightPrimary,
      '--primary-foreground': fg,
      '--ring': vividStr,
      '--sidebar-primary': lightPrimary,
      '--sidebar-primary-foreground': fg,
      '--sidebar-ring': vividStr,
      '--glow-brand': vividStr,
      '--background': n(0.995, 0.0021, h),
      '--card': 'oklch(1 0 0)',
      '--popover': 'oklch(1 0 0)',
      '--secondary': n(0.965, lightBgC, h),
      '--muted': n(0.965, lightBgC, h),
      '--accent': n(0.955, lightSideC * 0.6, h),
      '--sidebar': n(0.965, lightBgC, h),
      '--sidebar-accent': n(0.93, lightSideC, h),
    },
    dark: {
      '--primary': darkPrimary,
      '--primary-foreground': fg,
      '--ring': vividStr,
      '--sidebar-primary': darkPrimary,
      '--sidebar-primary-foreground': fg,
      '--sidebar-ring': vividStr,
      '--glow-brand': vividStr,
      '--background': n(0.185, darkC, h),
      '--card': n(0.215, darkC, h),
      '--popover': n(0.225, darkC, h),
      '--secondary': n(0.265, darkC, h),
      '--muted': n(0.255, darkC, h),
      '--accent': n(0.27, darkC + 0.004, h),
      '--sidebar': n(0.155, darkC, h),
      '--sidebar-accent': n(0.25, darkC + 0.004, h),
    },
  };
}

/** The union of custom-token property names, for clean teardown when switching away. */
export const CUSTOM_ACCENT_VARS = [
  '--primary',
  '--primary-foreground',
  '--ring',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-ring',
  '--glow-brand',
  '--background',
  '--card',
  '--popover',
  '--secondary',
  '--muted',
  '--accent',
  '--sidebar',
  '--sidebar-accent',
] as const;
