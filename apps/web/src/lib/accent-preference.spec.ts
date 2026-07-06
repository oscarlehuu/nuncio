import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACCENT_STORAGE_KEY,
  ACCENTS,
  DEFAULT_ACCENT,
  loadAccentPreference,
  saveAccentPreference,
} from './accent-preference';

beforeEach(() => {
  localStorage.clear();
});

describe('accent-preference', () => {
  it('defaults to cobalt', () => {
    expect(DEFAULT_ACCENT).toBe('cobalt');
    expect(loadAccentPreference()).toBe('cobalt');
  });

  it('exposes exactly the five presets', () => {
    expect([...ACCENTS]).toEqual(['mono', 'iris', 'cobalt', 'ember', 'jade']);
  });

  it('round-trips a saved accent through storage', () => {
    saveAccentPreference('ember');
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe('ember');
    expect(loadAccentPreference()).toBe('ember');
  });

  it('falls back to the default for an unknown stored value', () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, 'chartreuse');
    expect(loadAccentPreference()).toBe(DEFAULT_ACCENT);
  });
});
