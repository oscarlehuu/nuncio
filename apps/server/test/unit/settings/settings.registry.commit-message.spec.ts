import { getSettingDefinition } from '../../../src/settings/settings.registry';

describe('SETTING_DEFINITIONS — generated commit messages', () => {
  it('registers the commit-message model setting', () => {
    const def = getSettingDefinition('NUNCIO_COMMIT_MESSAGE_MODEL');
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.type).toBe('string');
    expect(def!.envVar).toBe('NUNCIO_COMMIT_MESSAGE_MODEL');
    expect(def!.description).toMatch(/provider:modelId/);
  });

  it('registers the editable commit-message instruction setting', () => {
    const def = getSettingDefinition('NUNCIO_COMMIT_MESSAGE_INSTRUCTION');
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.type).toBe('string');
    expect(def!.envVar).toBe('NUNCIO_COMMIT_MESSAGE_INSTRUCTION');
    // The description must tell the user the instruction is auto-learned from
    // the repo's commit history when left empty.
    expect(def!.description).toMatch(/learn/i);
  });
});
