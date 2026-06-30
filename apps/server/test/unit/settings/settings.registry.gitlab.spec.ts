import {
  SETTING_DEFINITIONS,
  getSettingDefinition,
  isSecretSetting,
} from '../../../src/settings/settings.registry';

describe('SETTING_DEFINITIONS — GitLab forge keys (Phase 5)', () => {
  it('registers GITLAB_TOKEN as an encrypted gitlab provider secret', () => {
    const def = getSettingDefinition('GITLAB_TOKEN');
    expect(def).toBeDefined();
    expect(def!.type).toBe('secret');
    expect(def!.category).toBe('provider');
    expect(def!.providerId).toBe('gitlab');
    expect(def!.envVar).toBe('GITLAB_TOKEN');
  });

  it('registers GITLAB_API_URL as a string with the public default base URL', () => {
    const def = getSettingDefinition('GITLAB_API_URL');
    expect(def).toBeDefined();
    expect(def!.type).toBe('string');
    expect(def!.category).toBe('provider');
    expect(def!.providerId).toBe('gitlab');
    expect(def!.envVar).toBe('GITLAB_API_URL');
    expect(def!.default).toBe('https://gitlab.com/api/v4');
  });

  it('registers GITLAB_WEBHOOK_SECRET as a gitlab provider secret', () => {
    const def = getSettingDefinition('GITLAB_WEBHOOK_SECRET');
    expect(def).toBeDefined();
    expect(def!.type).toBe('secret');
    expect(def!.category).toBe('provider');
    expect(def!.providerId).toBe('gitlab');
    expect(def!.envVar).toBe('GITLAB_WEBHOOK_SECRET');
  });

  it('appends the three gitlab keys to SETTING_DEFINITIONS', () => {
    const keys = SETTING_DEFINITIONS.map((d) => d.key);
    expect(keys).toEqual(
      expect.arrayContaining(['GITLAB_TOKEN', 'GITLAB_API_URL', 'GITLAB_WEBHOOK_SECRET']),
    );
  });

  it('marks only the credential keys as secret', () => {
    expect(isSecretSetting('GITLAB_TOKEN')).toBe(true);
    expect(isSecretSetting('GITLAB_WEBHOOK_SECRET')).toBe(true);
    expect(isSecretSetting('GITLAB_API_URL')).toBe(false);
  });
});
