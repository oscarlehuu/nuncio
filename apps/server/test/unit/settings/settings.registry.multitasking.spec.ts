import { getSettingDefinition } from '../../../src/settings/settings.registry';
import type { SettingCategory } from '../../../src/settings/settings.types';

describe('SETTING_DEFINITIONS — multitasking defaults', () => {
  it('supports Cursor-style settings sections without provider-specific categories', () => {
    const categories: SettingCategory[] = ['provider', 'general', 'agents', 'tools', 'workspaces', 'network', 'advanced'];
    expect(categories).toContain('agents');
    expect(categories).toContain('tools');
    expect(categories).toContain('workspaces');
    expect(categories).toContain('network');
    expect(categories).toContain('advanced');
  });

  it('registers a provider-neutral default subagent provider setting', () => {
    const def = getSettingDefinition('NUNCIO_SUBAGENT_PROVIDER');
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.providerId).toBeUndefined();
    expect(def!.type).toBe('string');
    expect(def!.label).toBe('Default subagent provider');
    expect(def!.envVar).toBe('NUNCIO_SUBAGENT_PROVIDER');
    expect(def!.description).toMatch(/provider-neutral/i);
  });

  it('registers a provider-neutral default subagent model setting', () => {
    const def = getSettingDefinition('NUNCIO_SUBAGENT_MODEL');
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.providerId).toBeUndefined();
    expect(def!.type).toBe('string');
    expect(def!.label).toBe('Default subagent model');
    expect(def!.envVar).toBe('NUNCIO_SUBAGENT_MODEL');
    expect(def!.description).toMatch(/provider-neutral/i);
  });

  it('registers subagent cleanup policy metadata without implementing cleanup behavior', () => {
    const def = getSettingDefinition('NUNCIO_SUBAGENT_CLEANUP_POLICY');
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.providerId).toBeUndefined();
    expect(def!.type).toBe('string');
    expect(def!.label).toBe('Subagent cleanup policy');
    expect(def!.envVar).toBe('NUNCIO_SUBAGENT_CLEANUP_POLICY');
    expect(def!.default).toBe('after-review');
    expect(def!.description).toContain('snapshot later');
  });

  it('reuses NUNCIO_TASK_CONCURRENCY as the max parallel subtasks setting', () => {
    const def = getSettingDefinition('NUNCIO_TASK_CONCURRENCY');
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.providerId).toBeUndefined();
    expect(def!.type).toBe('string');
    expect(def!.label).toBe('Max parallel subtasks');
    expect(def!.envVar).toBe('NUNCIO_TASK_CONCURRENCY');
    expect(def!.default).toBe('1');
    expect(def!.description).toContain('subtasks');
  });

  it('registers a per-provider default subagent models map setting', () => {
    const def = getSettingDefinition('NUNCIO_SUBAGENT_MODELS');
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.providerId).toBeUndefined();
    expect(def!.type).toBe('string');
    expect(def!.label).toBe('Default subagent models');
    expect(def!.envVar).toBe('NUNCIO_SUBAGENT_MODELS');
    expect(def!.default).toBeUndefined();
    expect(def!.description).toMatch(/JSON map/i);
  });

  it('registers the multitask launch countdown setting with a 15s default', () => {
    const def = getSettingDefinition('NUNCIO_MULTITASK_COUNTDOWN_SECONDS');
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.providerId).toBeUndefined();
    expect(def!.type).toBe('string');
    expect(def!.label).toBe('Multitask launch countdown');
    expect(def!.envVar).toBe('NUNCIO_MULTITASK_COUNTDOWN_SECONDS');
    expect(def!.default).toBe('15');
    expect(def!.description).toMatch(/seconds/i);
  });

  it('notes the legacy fallback role on the single default subagent model setting', () => {
    const def = getSettingDefinition('NUNCIO_SUBAGENT_MODEL');
    expect(def!.description).toMatch(/legacy/i);
  });

  it('registers a provider-neutral default browser target setting for tools', () => {
    const def = getSettingDefinition('NUNCIO_BROWSER_DEFAULT_TARGET');
    expect(def).toBeDefined();
    expect(def!.category).toBe('tools');
    expect(def!.providerId).toBeUndefined();
    expect(def!.type).toBe('string');
    expect(def!.label).toBe('Default browser');
    expect(def!.envVar).toBe('NUNCIO_BROWSER_DEFAULT_TARGET');
    expect(def!.default).toBe('auto');
    expect(def!.options?.map((option) => option.value)).toEqual(['auto', 'in_app', 'external']);
  });
});
