import { describe, it, expect, mock } from 'bun:test';
import { resolveModelId } from '../../../src/agents/providers/pi-agent.provider';

describe('resolveModelId', () => {
  it('splits provider:modelId (colon) and delegates to find', () => {
    const find = mock((provider: string, id: string) => ({ provider, id }));
    expect(resolveModelId('anthropic:claude-opus-4', find)).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-4',
    });
    expect(find).toHaveBeenCalledWith('anthropic', 'claude-opus-4');
  });

  it('splits provider/modelId (slash, Pi SDK convention) and delegates to find', () => {
    const find = mock((provider: string, id: string) => ({ provider, id }));
    expect(resolveModelId('openai/gpt-5.5', find)).toEqual({
      provider: 'openai',
      id: 'gpt-5.5',
    });
    expect(find).toHaveBeenCalledWith('openai', 'gpt-5.5');
  });

  it('returns undefined for ids without a provider separator', () => {
    const find = mock(() => undefined);
    expect(resolveModelId('claude-fable-5', find)).toBeUndefined();
    expect(resolveModelId(':leadingslice', find)).toBeUndefined();
    expect(resolveModelId('/leadingslice', find)).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it('returns undefined for empty or null input', () => {
    const find = mock(() => undefined);
    expect(resolveModelId('', find)).toBeUndefined();
    expect(resolveModelId(null, find)).toBeUndefined();
    expect(resolveModelId(undefined, find)).toBeUndefined();
    expect(resolveModelId('   ', find)).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it('propagates an unresolved lookup as undefined', () => {
    const find = mock(() => undefined);
    expect(resolveModelId('anthropic:unknown-model', find)).toBeUndefined();
    expect(find).toHaveBeenCalledWith('anthropic', 'unknown-model');
  });
});
