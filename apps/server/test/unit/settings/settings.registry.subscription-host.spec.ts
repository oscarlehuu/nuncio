import { getSettingDefinition } from '../../../src/settings/settings.registry';

describe('settings.registry Subscription model host', () => {
  it('exposes the enable toggle under the subscription-host provider (off by default)', () => {
    expect(getSettingDefinition('NUNCIO_SUBHOST_ENABLED')).toMatchObject({
      providerId: 'subscription-host',
      category: 'provider',
      type: 'boolean',
      default: '0',
      envVar: 'NUNCIO_SUBHOST_ENABLED',
    });
  });

  it('exposes managed/adopt mode', () => {
    const def = getSettingDefinition('NUNCIO_SUBHOST_MODE');
    expect(def).toMatchObject({ providerId: 'subscription-host', type: 'string', default: 'managed' });
    expect(def?.options?.map((o) => o.value)).toEqual(['managed', 'external']);
  });

  it('exposes a pinned version and broker/router ports', () => {
    expect(getSettingDefinition('NUNCIO_SUBHOST_VERSION')).toMatchObject({
      providerId: 'subscription-host',
      type: 'string',
      default: '0.1.0',
    });
    expect(getSettingDefinition('NUNCIO_SUBHOST_BROKER_PORT')).toMatchObject({ default: '18700' });
    expect(getSettingDefinition('NUNCIO_SUBHOST_ROUTER_PORT')).toMatchObject({ default: '18701' });
  });

  it('never leaks the underlying package name in any label or description', () => {
    for (const key of [
      'NUNCIO_SUBHOST_ENABLED',
      'NUNCIO_SUBHOST_MODE',
      'NUNCIO_SUBHOST_VERSION',
      'NUNCIO_SUBHOST_BROKER_PORT',
      'NUNCIO_SUBHOST_ROUTER_PORT',
    ]) {
      const def = getSettingDefinition(key);
      const text = `${def?.label} ${def?.description}`.toLowerCase();
      expect(text).not.toContain('oh-my-pi');
      expect(text).not.toContain('pi-coding-agent');
    }
  });
});
