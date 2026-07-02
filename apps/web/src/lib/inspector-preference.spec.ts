import { describe, it, expect, beforeEach } from 'vitest';
import {
  INSPECTOR_PREFERENCE_STORAGE_KEY,
  loadInspectorPreference,
  saveInspectorPreference,
} from './inspector-preference';

describe('inspector-preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the closed default when nothing is stored', () => {
    expect(loadInspectorPreference()).toEqual({ version: 1, open: false, tool: null });
  });

  it('round-trips a saved preference', () => {
    saveInspectorPreference({ version: 1, open: true, tool: 'terminal' });
    expect(loadInspectorPreference()).toEqual({ version: 1, open: true, tool: 'terminal' });
  });

  it('falls back to the default on corrupt JSON', () => {
    localStorage.setItem(INSPECTOR_PREFERENCE_STORAGE_KEY, '{not json');
    expect(loadInspectorPreference()).toEqual({ version: 1, open: false, tool: null });
  });

  it('falls back to the default on an unknown version', () => {
    localStorage.setItem(
      INSPECTOR_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 2, open: true, tool: 'scm' }),
    );
    expect(loadInspectorPreference()).toEqual({ version: 1, open: false, tool: null });
  });

  it('drops an unknown tool and closes the panel', () => {
    localStorage.setItem(
      INSPECTOR_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 1, open: true, tool: 'debugger' }),
    );
    expect(loadInspectorPreference()).toEqual({ version: 1, open: false, tool: null });
  });

  it('normalizes an open panel without a tool to closed', () => {
    localStorage.setItem(
      INSPECTOR_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 1, open: true, tool: null }),
    );
    expect(loadInspectorPreference()).toEqual({ version: 1, open: false, tool: null });
  });
});
