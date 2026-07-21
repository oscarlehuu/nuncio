import {
  classifyBridgeSource,
  codexModelsForClaudePicker,
  isCodexBridgeModelId,
  parseBridgeModelsResponse,
} from '../../../src/subscription-bridge/subscription-bridge.catalog';

describe('subscription-bridge.catalog', () => {
  it('classifies openai owned_by as codex-sub', () => {
    expect(classifyBridgeSource('openai', 'gpt-5.6-sol')).toBe('codex-sub');
  });

  it('classifies anthropic owned_by as claude-sub', () => {
    expect(classifyBridgeSource('anthropic', 'claude-opus-4-8')).toBe('claude-sub');
  });

  it('detects Codex bridge model ids by prefix', () => {
    expect(isCodexBridgeModelId('gpt-5.6-sol')).toBe(true);
    expect(isCodexBridgeModelId('claude-opus-4-8')).toBe(false);
    expect(isCodexBridgeModelId('opus')).toBe(false);
  });

  it('parses OpenAI /v1/models payloads', () => {
    const models = parseBridgeModelsResponse({
      data: [
        { id: 'gpt-5.6-sol', display_name: 'GPT 5.6 Sol', owned_by: 'openai' },
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', owned_by: 'anthropic' },
      ],
    });
    expect(models).toEqual([
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT 5.6 Sol',
        source: 'codex-sub',
        ownedBy: 'openai',
      },
      {
        id: 'claude-opus-4-8',
        displayName: 'Claude Opus 4.8',
        source: 'claude-sub',
        ownedBy: 'anthropic',
      },
    ]);
  });

  it('filters Claude picker Codex models to coding gpt-* ids', () => {
    const picked = codexModelsForClaudePicker([
      { id: 'gpt-5.6-sol', displayName: 'GPT 5.6 Sol', source: 'codex-sub' },
      { id: 'gpt-image-1.5', displayName: 'GPT Image 1.5', source: 'codex-sub' },
      { id: 'claude-opus-4-8', displayName: 'Opus', source: 'claude-sub' },
      {
        id: 'claude-fable-5-dd-los-6.5-tpg',
        displayName: 'GPT 5.6 Sol',
        source: 'codex-sub',
      },
    ]);
    expect(picked.map((m) => m.id)).toEqual(['gpt-5.6-sol']);
  });
});
