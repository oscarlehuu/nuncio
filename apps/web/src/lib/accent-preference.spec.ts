import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACCENT_STORAGE_KEY,
  ACCENTS,
  CUSTOM_ACCENT_HEX_KEY,
  DEFAULT_ACCENT,
  DEFAULT_CUSTOM_HEX,
  loadAccentPreference,
  loadCustomAccentHex,
  PRESET_ACCENTS,
  saveAccentPreference,
  saveCustomAccentHex,
} from './accent-preference';

beforeEach(() => {
  localStorage.clear();
});

describe('accent-preference', () => {
  it('defaults to cobalt', () => {
    expect(DEFAULT_ACCENT).toBe('cobalt');
    expect(loadAccentPreference()).toBe('cobalt');
  });

  it('exposes the five preset swatches plus a custom slot', () => {
    expect([...PRESET_ACCENTS]).toEqual(['mono', 'iris', 'cobalt', 'ember', 'jade']);
    expect([...ACCENTS]).toEqual(['mono', 'iris', 'cobalt', 'ember', 'jade', 'custom']);
  });

  it('round-trips a saved accent through storage', () => {
    saveAccentPreference('ember');
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe('ember');
    expect(loadAccentPreference()).toBe('ember');
  });

  it('round-trips a custom accent selection', () => {
    saveAccentPreference('custom');
    expect(loadAccentPreference()).toBe('custom');
  });

  it('falls back to the default for an unknown stored value', () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, 'chartreuse');
    expect(loadAccentPreference()).toBe(DEFAULT_ACCENT);
  });

  it('persists + normalizes the custom hex, rejecting garbage', () => {
    expect(loadCustomAccentHex()).toBe(DEFAULT_CUSTOM_HEX);
    saveCustomAccentHex('AABBCC');
    expect(localStorage.getItem(CUSTOM_ACCENT_HEX_KEY)).toBe('#aabbcc');
    expect(loadCustomAccentHex()).toBe('#aabbcc');
    saveCustomAccentHex('not-a-hex');
    expect(loadCustomAccentHex()).toBe('#aabbcc');
  });
});
