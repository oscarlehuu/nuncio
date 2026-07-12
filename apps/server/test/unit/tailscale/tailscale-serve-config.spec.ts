import { describe, expect, it } from 'bun:test';
import { publishedRelayStatusFromConfig } from '../../../src/tailscale/tailscale-serve-config';

describe('publishedRelayStatusFromConfig', () => {
  it('finds a matching serve proxy and enabled Funnel entry', () => {
    const config = {
      Web: {
        'mac.example.ts.net:443': {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } },
        },
      },
      AllowFunnel: { 'mac.example.ts.net:443': true },
    };
    expect(publishedRelayStatusFromConfig(config, 3000)).toEqual({ serve: true, funnel: true });
  });

  it('does not report another port or malformed JSON as published', () => {
    expect(publishedRelayStatusFromConfig(
      { Web: { x: { Proxy: 'http://127.0.0.1:4000' } } },
      3000,
    )).toEqual({ serve: false, funnel: false });
    expect(publishedRelayStatusFromConfig(null, 3000)).toEqual({
      serve: false,
      funnel: false,
    });
  });

  it('does not borrow Funnel permission from a different published host', () => {
    const config = {
      Web: {
        'relay.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
        'other.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4000' } } },
      },
      AllowFunnel: { 'other.example.ts.net:443': true },
    };
    expect(publishedRelayStatusFromConfig(config, 3000)).toEqual({ serve: true, funnel: false });
  });
});
