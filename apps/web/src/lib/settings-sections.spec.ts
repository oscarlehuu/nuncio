import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS_SECTION,
  parseSettingsSection,
  SETTINGS_SECTION_NAV_ITEMS,
} from './settings-sections';

describe('settings-sections', () => {
  it('exposes the full Cursor-style section list', () => {
    expect(SETTINGS_SECTION_NAV_ITEMS.map((item) => item.id)).toEqual([
      'general',
      'appearance',
      'providers',
      'usage',
      'source-control',
      'mcp-tools',
      'agents',
      'crew-profiles',
      'workspaces',
      'projects',
      'mobile',
      'remote-access',
      'advanced',
    ]);
  });

  it('parses known ?section= values and falls back for unknown', () => {
    expect(parseSettingsSection('?section=remote-access')).toBe('remote-access');
    expect(parseSettingsSection('section=crew-profiles')).toBe('crew-profiles');
    expect(parseSettingsSection('?section=mobile')).toBe('mobile');
    expect(parseSettingsSection('?section=subscription-bridge')).toBe('providers');
    expect(parseSettingsSection('?section=tool-updates')).toBe('providers');
    expect(parseSettingsSection('?section=not-real')).toBe(DEFAULT_SETTINGS_SECTION);
    expect(parseSettingsSection('')).toBe('appearance');
  });
});
