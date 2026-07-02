import { describe, expect, it } from 'bun:test';
import { isAuthorizedHubRequest, isPublicHubTargetPath } from '../../../src/hub/hub.proxy';
import type { TokenValidator } from '../../../src/auth/auth-request';

const tokens: TokenValidator = {
  isValidToken: (candidate) => candidate === 'secret',
};

const remote = { socket: { remoteAddress: '192.168.1.20' } };

describe('isPublicHubTargetPath', () => {
  it('mirrors the target @Public routes', () => {
    expect(isPublicHubTargetPath('/api/auth/login')).toBe(true);
    expect(isPublicHubTargetPath('/api/health')).toBe(true);
    expect(isPublicHubTargetPath('/api/webhooks/forge/github')).toBe(true);
  });

  it('ignores query strings', () => {
    expect(isPublicHubTargetPath('/api/health?probe=1')).toBe(true);
  });

  it('treats everything else as protected', () => {
    expect(isPublicHubTargetPath('/api/sessions')).toBe(false);
    expect(isPublicHubTargetPath('/api/sessions/abc/stream?since=0')).toBe(false);
    expect(isPublicHubTargetPath('/api/settings')).toBe(false);
  });
});

describe('isAuthorizedHubRequest', () => {
  it('lets public target paths through without credentials', async () => {
    expect(await isAuthorizedHubRequest(remote, '/api/auth/login', tokens)).toBe(true);
  });

  it('refuses protected paths for remote clients without a token', async () => {
    expect(await isAuthorizedHubRequest(remote, '/api/sessions', tokens)).toBe(false);
  });

  it('accepts a Bearer token or auth cookie on protected paths', async () => {
    const bearer = { ...remote, headers: { authorization: 'Bearer secret' } };
    expect(await isAuthorizedHubRequest(bearer, '/api/sessions', tokens)).toBe(true);

    const cookie = { ...remote, headers: { cookie: 'nuncio_token=secret' } };
    expect(await isAuthorizedHubRequest(cookie, '/api/sessions', tokens)).toBe(true);
  });

  it('accepts loopback and trusted tailnet peers', async () => {
    const loopback = { socket: { remoteAddress: '127.0.0.1' } };
    expect(await isAuthorizedHubRequest(loopback, '/api/sessions', tokens)).toBe(true);

    const trust = { isTrustedRemote: async (addr: unknown) => addr === '100.64.0.9' };
    const peer = { socket: { remoteAddress: '100.64.0.9' } };
    expect(await isAuthorizedHubRequest(peer, '/api/sessions', tokens, trust)).toBe(true);
  });
});
