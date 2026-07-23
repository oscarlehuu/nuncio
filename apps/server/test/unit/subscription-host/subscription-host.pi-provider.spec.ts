import { describe, it, expect } from 'bun:test';
import {
  buildSubscriptionHostProviderConfig,
  mapRouterApiToPiApi,
} from '../../../src/subscription-host/subscription-host.pi-provider';

describe('mapRouterApiToPiApi', () => {
  it('passes through known pi api ids untouched', () => {
    expect(mapRouterApiToPiApi('anthropic-messages')).toBe('anthropic-messages');
    expect(mapRouterApiToPiApi('openai-responses')).toBe('openai-responses');
    expect(mapRouterApiToPiApi('openai-codex-responses')).toBe('openai-codex-responses');
  });

  it('maps anthropic/claude/messages shapes to anthropic-messages', () => {
    expect(mapRouterApiToPiApi('anthropic')).toBe('anthropic-messages');
    expect(mapRouterApiToPiApi('claude')).toBe('anthropic-messages');
    expect(mapRouterApiToPiApi('messages')).toBe('anthropic-messages');
  });

  it('maps codex and responses shapes to their OpenAI-family api', () => {
    expect(mapRouterApiToPiApi('codex')).toBe('openai-codex-responses');
    expect(mapRouterApiToPiApi('responses')).toBe('openai-responses');
  });

  it('maps gemini/google shapes to google-generative-ai', () => {
    expect(mapRouterApiToPiApi('gemini')).toBe('google-generative-ai');
    expect(mapRouterApiToPiApi('google')).toBe('google-generative-ai');
  });

  it('defaults empty/unknown/chat shapes to openai-completions', () => {
    expect(mapRouterApiToPiApi(undefined)).toBe('openai-completions');
    expect(mapRouterApiToPiApi('')).toBe('openai-completions');
    expect(mapRouterApiToPiApi('chat')).toBe('openai-completions');
    expect(mapRouterApiToPiApi('something-else')).toBe('openai-completions');
  });
});

describe('buildSubscriptionHostProviderConfig', () => {
  it('routes the catalog to the router /v1 endpoint with no-auth transport', () => {
    const config = buildSubscriptionHostProviderConfig('http://127.0.0.1:18701/', [
      { id: 'gpt-5-sol', displayName: 'GPT-5 Sol', api: 'openai-responses' },
      { id: 'claude-sub', displayName: 'Claude Sub', api: 'anthropic-messages' },
    ]);

    expect(config.baseUrl).toBe('http://127.0.0.1:18701/v1');
    // The router runs --no-auth on loopback, so no bearer is attached.
    expect(config.authHeader).toBe(false);
    expect(config.models?.map((m) => [m.id, m.api])).toEqual([
      ['gpt-5-sol', 'openai-responses'],
      ['claude-sub', 'anthropic-messages'],
    ]);
  });

  it('uses conservative defaults keyed by api family for router-absent metadata', () => {
    const config = buildSubscriptionHostProviderConfig('http://127.0.0.1:18701', [
      { id: 'gpt-5-sol', displayName: 'GPT-5 Sol', api: 'openai-completions' },
      { id: 'claude-sub', displayName: 'Claude Sub', api: 'anthropic-messages' },
    ]);
    const openai = config.models?.find((m) => m.id === 'gpt-5-sol');
    const anthropic = config.models?.find((m) => m.id === 'claude-sub');

    expect(openai?.contextWindow).toBe(128_000);
    expect(anthropic?.contextWindow).toBe(200_000);
    expect(openai?.reasoning).toBe(false);
    expect(openai?.input).toEqual(['text']);
    expect(openai?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('prefers a known built-in metadata when a host model id matches', () => {
    const config = buildSubscriptionHostProviderConfig(
      'http://127.0.0.1:18701',
      [{ id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4', api: 'anthropic-messages' }],
      (id) =>
        id === 'claude-sonnet-4'
          ? {
              id,
              reasoning: true,
              input: ['text', 'image'],
              contextWindow: 1_000_000,
              maxTokens: 64_000,
              cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            }
          : undefined,
    );
    const model = config.models?.[0];

    // Transport api stays the router's; the rest reuses the built-in's real numbers.
    expect(model?.api).toBe('anthropic-messages');
    expect(model?.reasoning).toBe(true);
    expect(model?.input).toEqual(['text', 'image']);
    expect(model?.contextWindow).toBe(1_000_000);
    expect(model?.maxTokens).toBe(64_000);
    expect(model?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });
});
