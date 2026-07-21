import { getSettingDefinition } from '../../../src/settings/settings.registry';

describe('settings.registry Subscription bridge', () => {
  it('exposes enable toggle under subscription-bridge provider', () => {
    const def = getSettingDefinition('NUNCIO_CLIPROXY_ENABLED');
    expect(def).toMatchObject({
      providerId: 'subscription-bridge',
      category: 'provider',
      type: 'boolean',
      default: '0',
      envVar: 'NUNCIO_CLIPROXY_ENABLED',
    });
  });

  it('exposes base URL with localhost CLIProxyAPI default', () => {
    const def = getSettingDefinition('NUNCIO_CLIPROXY_BASE_URL');
    expect(def).toMatchObject({
      providerId: 'subscription-bridge',
      category: 'provider',
      type: 'string',
      default: 'http://127.0.0.1:8317',
      envVar: 'NUNCIO_CLIPROXY_BASE_URL',
    });
  });

  it('exposes API key as a secret', () => {
    const def = getSettingDefinition('NUNCIO_CLIPROXY_API_KEY');
    expect(def).toMatchObject({
      providerId: 'subscription-bridge',
      category: 'provider',
      type: 'secret',
      envVar: 'NUNCIO_CLIPROXY_API_KEY',
    });
  });

  it('exposes optional CLIProxyAPI binary path', () => {
    const def = getSettingDefinition('NUNCIO_CLIPROXY_BIN');
    expect(def).toMatchObject({
      providerId: 'subscription-bridge',
      category: 'provider',
      type: 'path',
      envVar: 'NUNCIO_CLIPROXY_BIN',
    });
  });
});
