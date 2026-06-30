import {
  SETTING_DEFINITIONS,
  getSettingDefinition,
  isSecretSetting,
} from '../../../src/settings/settings.registry';

describe('SETTING_DEFINITIONS — GitHub forge keys (Phase 2)', () => {
  it('registers GITHUB_TOKEN as an encrypted github provider secret', () => {
    const def = getSettingDefinition('GITHUB_TOKEN');
    expect(def).toBeDefined();
    expect(def!.type).toBe('secret');
    expect(def!.category).toBe('provider');
    expect(def!.providerId).toBe('github');
    expect(def!.envVar).toBe('GITHUB_TOKEN');
  });

  it('registers GITHUB_API_URL as a string with the public default base URL', () => {
    const def = getSettingDefinition('GITHUB_API_URL');
    expect(def).toBeDefined();
    expect(def!.type).toBe('string');
    expect(def!.category).toBe('provider');
    expect(def!.providerId).toBe('github');
    expect(def!.envVar).toBe('GITHUB_API_URL');
    expect(def!.default).toBe('https://api.github.com');
  });

  it('registers GITHUB_WEBHOOK_SECRET as a github provider secret', () => {
    const def = getSettingDefinition('GITHUB_WEBHOOK_SECRET');
    expect(def).toBeDefined();
    expect(def!.type).toBe('secret');
    expect(def!.category).toBe('provider');
    expect(def!.providerId).toBe('github');
    expect(def!.envVar).toBe('GITHUB_WEBHOOK_SECRET');
  });

  it('appends the three github keys to SETTING_DEFINITIONS', () => {
    const keys = SETTING_DEFINITIONS.map((d) => d.key);
    expect(keys).toEqual(
      expect.arrayContaining(['GITHUB_TOKEN', 'GITHUB_API_URL', 'GITHUB_WEBHOOK_SECRET']),
    );
  });

  it('marks only the credential keys as secret', () => {
    expect(isSecretSetting('GITHUB_TOKEN')).toBe(true);
    expect(isSecretSetting('GITHUB_WEBHOOK_SECRET')).toBe(true);
    expect(isSecretSetting('GITHUB_API_URL')).toBe(false);
  });
});
