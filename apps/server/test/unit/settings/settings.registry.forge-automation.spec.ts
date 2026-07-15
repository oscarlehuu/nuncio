import { getSettingDefinition } from '../../../src/settings/settings.registry';

describe('forge automation settings', () => {
  it('enables webhook auto-steer by default', () => {
    expect(getSettingDefinition('forges.autoSteer')).toMatchObject({
      key: 'forges.autoSteer',
      type: 'boolean',
      default: '1',
    });
  });

  it('enables merged-session cleanup by default', () => {
    expect(getSettingDefinition('forges.autoCloseOnMerge')).toMatchObject({
      key: 'forges.autoCloseOnMerge',
      type: 'boolean',
      default: '1',
    });
  });
});
