import { describe, expect, it } from 'bun:test';
import { getSettingDefinition } from '../../../src/settings/settings.registry';

describe('external memory settings', () => {
  it('registers Nuncio Engine memory mode and budget controls', () => {
    const mode = getSettingDefinition('PI_EXTERNAL_MEMORIES');
    expect(mode).toMatchObject({ providerId: 'pi', default: 'all' });
    expect(mode?.options?.map((option) => option.value)).toEqual(['off', 'claude', 'codex', 'all']);

    expect(getSettingDefinition('PI_EXTERNAL_MEMORIES_MAX_BYTES')).toMatchObject({
      providerId: 'pi',
      default: '12288',
    });
    expect(getSettingDefinition('NUNCIO_CLAUDE_CONFIG_DIR')).toMatchObject({
      providerId: 'pi',
      type: 'path',
      default: '~/.claude',
      altEnvVar: 'CLAUDE_CONFIG_DIR',
    });
  });
});
