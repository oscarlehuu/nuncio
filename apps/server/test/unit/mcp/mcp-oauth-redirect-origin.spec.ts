import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { redirectOriginFromRequest } from '../../../src/mcp/oauth/mcp-oauth-redirect-origin';

describe('redirectOriginFromRequest', () => {
  it('uses host + protocol from the request', () => {
    expect(
      redirectOriginFromRequest({
        protocol: 'https',
        headers: { host: 'mac.tailnet.ts.net' },
      }),
    ).toBe('https://mac.tailnet.ts.net');
  });

  it('prefers x-forwarded-* when present', () => {
    expect(
      redirectOriginFromRequest({
        protocol: 'http',
        headers: {
          host: '127.0.0.1:3000',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'mac.tailnet.ts.net',
        },
      }),
    ).toBe('https://mac.tailnet.ts.net');
  });

  it('rejects missing or unsafe hosts', () => {
    expect(() => redirectOriginFromRequest({ headers: {} })).toThrow(BadRequestException);
    expect(() =>
      redirectOriginFromRequest({ headers: { host: 'evil.com/@phish' } }),
    ).toThrow(BadRequestException);
  });
});
