import { getSettingDefinition } from '../../../src/settings/settings.registry';

describe('engine visibility settings', () => {
  it('hides the legacy vendor engines by default', () => {
    expect(getSettingDefinition('engines.showLegacy')).toMatchObject({
      key: 'engines.showLegacy',
      type: 'boolean',
      default: '0',
    });
  });
});
