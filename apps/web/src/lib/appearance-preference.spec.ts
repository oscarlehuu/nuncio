import { describe, it, expect, beforeEach } from 'vitest';
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  clampCodeFontSize,
  clampUiFontSize,
  loadAppearancePreference,
  resolveCodeFontStack,
  resolveUiFontStack,
  saveAppearancePreference,
} from './appearance-preference';

describe('appearance-preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns defaults when nothing stored', () => {
    expect(loadAppearancePreference()).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE.uiFontSize).toBe(14);
    expect(DEFAULT_APPEARANCE.codeFontSize).toBe(12);
    expect(DEFAULT_APPEARANCE.motion).toBe('system');
    expect(DEFAULT_APPEARANCE.pointerCursors).toBe(false);
    expect(DEFAULT_APPEARANCE.diffMarkers).toBe('color');
  });

  it('round-trips the full preference through localStorage', () => {
    const pref = {
      ...DEFAULT_APPEARANCE,
      fontScale: 1.2,
      density: 'compact' as const,
      uiFontSize: 16,
      codeFontSize: 14,
      motion: 'off' as const,
      pointerCursors: true,
      uiFont: 'system' as const,
      codeFont: 'jetbrains' as const,
      diffMarkers: 'symbol' as const,
    };
    saveAppearancePreference(pref);
    expect(loadAppearancePreference()).toEqual(pref);
  });

  it('clamps font sizes on load', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_APPEARANCE, uiFontSize: 40, codeFontSize: 2 }),
    );
    const loaded = loadAppearancePreference();
    expect(loaded.uiFontSize).toBe(18);
    expect(loaded.codeFontSize).toBe(10);
  });

  it('clamps helpers cover both bounds', () => {
    expect(clampUiFontSize(100)).toBe(18);
    expect(clampUiFontSize(1)).toBe(12);
    expect(clampCodeFontSize(100)).toBe(18);
    expect(clampCodeFontSize(1)).toBe(10);
  });

  it('clamps an out-of-range fontScale on load', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_APPEARANCE, fontScale: 5 }),
    );
    expect(loadAppearancePreference().fontScale).toBe(1.4);
  });

  it('falls back to defaults for unknown enum values', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_APPEARANCE, density: 'weird', motion: 'nope', diffMarkers: 'x' }),
    );
    const loaded = loadAppearancePreference();
    expect(loaded.density).toBe('comfortable');
    expect(loaded.motion).toBe('system');
    expect(loaded.diffMarkers).toBe('color');
  });

  it('returns defaults for corrupt JSON', () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, '{not json');
    expect(loadAppearancePreference()).toEqual(DEFAULT_APPEARANCE);
  });

  it('resolves font stacks including custom free-text', () => {
    expect(resolveUiFontStack({ ...DEFAULT_APPEARANCE, uiFont: 'system' })).toContain('system-ui');
    expect(
      resolveUiFontStack({ ...DEFAULT_APPEARANCE, uiFont: 'custom', uiFontCustom: 'Courier' }),
    ).toBe('Courier');
    expect(resolveCodeFontStack({ ...DEFAULT_APPEARANCE, codeFont: 'jetbrains' })).toContain(
      'JetBrains Mono',
    );
    // Empty custom falls back to the default stack, never an empty string.
    expect(
      resolveUiFontStack({ ...DEFAULT_APPEARANCE, uiFont: 'custom', uiFontCustom: '   ' }),
    ).toContain('Geist');
  });
});
