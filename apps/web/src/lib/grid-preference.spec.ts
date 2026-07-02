import { describe, it, expect, beforeEach } from 'vitest';
import {
  defaultGridPreference,
  fitSlots,
  GRID_PREFERENCE_STORAGE_KEY,
  loadGridPreference,
  saveGridPreference,
} from './grid-preference';

describe('grid-preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts as an empty 2x2 grid', () => {
    const pref = loadGridPreference();
    expect(pref.preset).toBe('2x2');
    expect(pref.slots).toHaveLength(4);
    expect(pref.slots.every((s) => s.sessionId === undefined)).toBe(true);
  });

  it('persists and restores preset + bindings', () => {
    saveGridPreference({
      version: 1,
      preset: '2x1',
      slots: [{ sessionId: 'a1b2' }, {}],
    });
    const restored = loadGridPreference();
    expect(restored.preset).toBe('2x1');
    expect(restored.slots).toEqual([{ sessionId: 'a1b2' }, {}]);
  });

  it('fits slots to the preset count on load (truncate extra bindings)', () => {
    saveGridPreference({
      version: 1,
      preset: '1x1',
      slots: [{ sessionId: 'keep' }, { sessionId: 'drop' }, { sessionId: 'drop2' }],
    });
    const restored = loadGridPreference();
    expect(restored.slots).toEqual([{ sessionId: 'keep' }]);
  });

  it('extends slots with empties when the preset is larger than the stored array', () => {
    saveGridPreference({ version: 1, preset: '2x2', slots: [{ sessionId: 'one' }] });
    const restored = loadGridPreference();
    expect(restored.slots).toHaveLength(4);
    expect(restored.slots[0]).toEqual({ sessionId: 'one' });
    expect(restored.slots.slice(1)).toEqual([{}, {}, {}]);
  });

  it('falls back to the default on corrupt JSON without throwing', () => {
    localStorage.setItem(GRID_PREFERENCE_STORAGE_KEY, '{not json');
    expect(() => loadGridPreference()).not.toThrow();
    expect(loadGridPreference()).toEqual(defaultGridPreference());
  });

  it('falls back to the default on an unknown version', () => {
    localStorage.setItem(
      GRID_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 99, preset: '3x2', slots: [{ sessionId: 'x' }] }),
    );
    expect(loadGridPreference()).toEqual(defaultGridPreference());
  });

  it('falls back to the default on an unknown preset', () => {
    localStorage.setItem(
      GRID_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 1, preset: '9x9', slots: [] }),
    );
    expect(loadGridPreference()).toEqual(defaultGridPreference());
  });

  it('tolerates a non-array slots payload', () => {
    localStorage.setItem(
      GRID_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 1, preset: '2x1', slots: 'nope' }),
    );
    const restored = loadGridPreference();
    expect(restored.preset).toBe('2x1');
    expect(restored.slots).toEqual([{}, {}]);
  });

  it('fitSlots preserves bindings when growing and drops the tail when shrinking', () => {
    const slots = [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }, { sessionId: 'd' }];
    expect(fitSlots(slots, '3x2')).toEqual([
      { sessionId: 'a' },
      { sessionId: 'b' },
      { sessionId: 'c' },
      { sessionId: 'd' },
      {},
      {},
    ]);
    expect(fitSlots(slots, '1x1')).toEqual([{ sessionId: 'a' }]);
  });
});
