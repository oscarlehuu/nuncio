import { describe, it, expect, beforeEach } from 'vitest';
import {
  INSPECTOR_PREFERENCE_STORAGE_KEY,
  loadInspectorPreference,
  saveInspectorPreference,
} from './inspector-preference';

const CLOSED_DEFAULT = { version: 1, open: false, tool: null, scmSegment: null };

describe('inspector-preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the closed default when nothing is stored', () => {
    expect(loadInspectorPreference()).toEqual(CLOSED_DEFAULT);
  });

  it('round-trips a saved preference', () => {
    saveInspectorPreference({ version: 1, open: true, tool: 'terminal', scmSegment: 'pulls' });
    expect(loadInspectorPreference()).toEqual({
      version: 1,
      open: true,
      tool: 'terminal',
      scmSegment: 'pulls',
    });
  });

  it('tolerates a stored preference without an scm segment', () => {
    localStorage.setItem(
      INSPECTOR_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 1, open: true, tool: 'scm' }),
    );
    expect(loadInspectorPreference()).toEqual({
      version: 1,
      open: true,
      tool: 'scm',
      scmSegment: null,
    });
  });

  it('maps the retired pr segment to changes', () => {
    localStorage.setItem(
      INSPECTOR_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 1, open: true, tool: 'scm', scmSegment: 'pr' }),
    );
    expect(loadInspectorPreference().scmSegment).toBe('changes');
  });

  it('drops an unknown scm segment', () => {
    localStorage.setItem(
      INSPECTOR_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 1, open: true, tool: 'scm', scmSegment: 'wiki' }),
    );
    expect(loadInspectorPreference()).toEqual({
      version: 1,
      open: true,
      tool: 'scm',
      scmSegment: null,
    });
  });

  it('falls back to the default on corrupt JSON', () => {
    localStorage.setItem(INSPECTOR_PREFERENCE_STORAGE_KEY, '{not json');
    expect(loadInspectorPreference()).toEqual(CLOSED_DEFAULT);
  });

  it('falls back to the default on an unknown version', () => {
    localStorage.setItem(
      INSPECTOR_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 2, open: true, tool: 'scm' }),
    );
    expect(loadInspectorPreference()).toEqual(CLOSED_DEFAULT);
  });

  it('drops an unknown tool and closes the panel', () => {
    localStorage.setItem(
      INSPECTOR_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 1, open: true, tool: 'debugger' }),
    );
    expect(loadInspectorPreference()).toEqual(CLOSED_DEFAULT);
  });

  it('normalizes an open panel without a tool to closed', () => {
    localStorage.setItem(
      INSPECTOR_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 1, open: true, tool: null }),
    );
    expect(loadInspectorPreference()).toEqual(CLOSED_DEFAULT);
  });
});
