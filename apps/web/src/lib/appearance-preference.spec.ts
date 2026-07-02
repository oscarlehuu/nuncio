import { describe, it, expect, beforeEach } from 'vitest';
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  loadAppearancePreference,
  saveAppearancePreference,
} from './appearance-preference';

describe('appearance-preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns defaults when nothing stored', () => {
    expect(loadAppearancePreference()).toEqual(DEFAULT_APPEARANCE);
  });

  it('round-trips fontScale + density through localStorage', () => {
    saveAppearancePreference({ fontScale: 1.2, density: 'compact' });
    expect(loadAppearancePreference()).toEqual({ fontScale: 1.2, density: 'compact' });
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!)).toEqual({
      fontScale: 1.2,
      density: 'compact',
    });
  });

  it('clamps an out-of-range fontScale on load', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ fontScale: 5, density: 'comfortable' }),
    );
    expect(loadAppearancePreference().fontScale).toBe(1.4);

    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ fontScale: 0.1, density: 'comfortable' }),
    );
    expect(loadAppearancePreference().fontScale).toBe(0.85);
  });

  it('returns defaults for corrupt JSON', () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, '{not json');
    expect(loadAppearancePreference()).toEqual(DEFAULT_APPEARANCE);
  });

  it('defaults density to comfortable for unknown value', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ fontScale: 1, density: 'weird' }),
    );
    expect(loadAppearancePreference().density).toBe('comfortable');
  });
});
