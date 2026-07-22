import { getSettingDefinition } from '../../../src/settings/settings.registry';

describe('SETTING_DEFINITIONS — after-image evidence auto-capture', () => {
  it('registers the auto-capture toggle, on by default via the 0/1 boolean convention', () => {
    const def = getSettingDefinition('NUNCIO_EVIDENCE_AUTO_CAPTURE');
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.type).toBe('boolean');
    // Boolean settings must default with '1'/'0' — the Settings switch reads a
    // boolean as enabled only when the stored value is '1', so 'true' would show
    // as off and the first toggle would fail to disable it.
    expect(def!.default).toBe('1');
    expect(def!.envVar).toBe('NUNCIO_EVIDENCE_AUTO_CAPTURE');
  });

  it('registers the evidence fallback URL as a string setting', () => {
    const def = getSettingDefinition('NUNCIO_EVIDENCE_URL');
    expect(def).toBeDefined();
    expect(def!.type).toBe('string');
  });
});
