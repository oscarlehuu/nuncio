import { getSettingDefinition } from '../../../src/settings/settings.registry';

describe('SETTING_DEFINITIONS — automatic session titles', () => {
  it('registers the auto-title toggle, on by default', () => {
    const def = getSettingDefinition('NUNCIO_AUTO_TITLE');
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.type).toBe('boolean');
    expect(def!.default).toBe('1');
    expect(def!.envVar).toBe('NUNCIO_AUTO_TITLE');
  });

  it('registers the auto branch-name toggle, on by default', () => {
    const def = getSettingDefinition('NUNCIO_AUTO_BRANCH_NAME');
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.type).toBe('boolean');
    expect(def!.default).toBe('1');
  });

  it('registers the session-title model setting', () => {
    const def = getSettingDefinition('NUNCIO_SESSION_TITLE_MODEL');
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.type).toBe('string');
    expect(def!.description).toMatch(/provider:modelId/);
  });
});
