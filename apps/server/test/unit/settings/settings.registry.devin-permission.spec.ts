import { getSettingDefinition } from '../../../src/settings/settings.registry';

describe('settings.registry Devin + Codex permission modes', () => {
  it('exposes NUNCIO_DEVIN_PERMISSION_MODE with bypass default and ACP mode options', () => {
    const def = getSettingDefinition('NUNCIO_DEVIN_PERMISSION_MODE');
    expect(def).toMatchObject({
      providerId: 'devin',
      category: 'provider',
      default: 'bypass',
      envVar: 'NUNCIO_DEVIN_PERMISSION_MODE',
    });
    expect(def!.options?.map((option) => option.value)).toEqual([
      'bypass',
      'accept-edits',
      'ask',
      'plan',
    ]);
  });

  it('exposes NUNCIO_DEVIN_BIN under the Devin provider', () => {
    const def = getSettingDefinition('NUNCIO_DEVIN_BIN');
    expect(def).toMatchObject({
      providerId: 'devin',
      category: 'provider',
      type: 'path',
      envVar: 'NUNCIO_DEVIN_BIN',
    });
  });

  it('lists Codex runtime mode options for the Settings select', () => {
    const def = getSettingDefinition('NUNCIO_CODEX_RUNTIME_MODE');
    expect(def!.default).toBe('full-access');
    expect(def!.options?.map((option) => option.value)).toEqual([
      'full-access',
      'approval-required',
    ]);
  });
});
