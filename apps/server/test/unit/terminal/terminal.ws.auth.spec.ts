import { describe, expect, it } from 'bun:test';
import { isAuthorizedTerminalUpgrade } from '../../../src/terminal/terminal.ws';
import type { TokenValidator } from '../../../src/auth/auth-request';
import type { DeviceValidator } from '../../../src/auth/device-token';

const tokens: TokenValidator = {
  isValidToken: (candidate) => candidate === 'secret',
};

const devices: DeviceValidator = {
  verifyDevice: (id, secret) => id === 'dev1' && secret === 'good',
};

describe('isAuthorizedTerminalUpgrade', () => {
  it('allows loopback upgrades with no token, even without a validator', async () => {
    const req = { socket: { remoteAddress: '127.0.0.1' } };
    expect(await isAuthorizedTerminalUpgrade(req)).toBe(true);
    expect(await isAuthorizedTerminalUpgrade(req, tokens)).toBe(true);
  });

  it('allows remote upgrades that carry the auth cookie or a Bearer header', async () => {
    const cookie = {
      socket: { remoteAddress: '192.168.1.20' },
      headers: { cookie: 'nuncio_token=secret' },
    };
    expect(await isAuthorizedTerminalUpgrade(cookie, tokens)).toBe(true);

    const bearer = {
      socket: { remoteAddress: '192.168.1.20' },
      headers: { authorization: 'Bearer secret' },
    };
    expect(await isAuthorizedTerminalUpgrade(bearer, tokens)).toBe(true);
  });

  it('allows a trusted tailnet peer via the trust checker', async () => {
    const trust = { isTrustedRemote: async (addr: unknown) => addr === '100.64.0.9' };
    const req = { socket: { remoteAddress: '100.64.0.9' } };
    expect(await isAuthorizedTerminalUpgrade(req, tokens, trust)).toBe(true);
    expect(
      await isAuthorizedTerminalUpgrade({ socket: { remoteAddress: '100.64.0.8' } }, tokens, trust),
    ).toBe(false);
  });

  it('treats a throwing trust checker as unauthorized', async () => {
    const trust = {
      isTrustedRemote: async () => {
        throw new Error('tailscaled down');
      },
    };
    const req = { socket: { remoteAddress: '100.64.0.9' } };
    expect(await isAuthorizedTerminalUpgrade(req, tokens, trust)).toBe(false);
  });

  it('refuses remote upgrades without a valid token', async () => {
    const remote = { remoteAddress: '192.168.1.20' };
    expect(await isAuthorizedTerminalUpgrade({ socket: remote }, tokens)).toBe(false);
    expect(
      await isAuthorizedTerminalUpgrade(
        { socket: remote, headers: { cookie: 'nuncio_token=wrong' } },
        tokens,
      ),
    ).toBe(false);
  });

  it('refuses every remote upgrade when no token validator or trust is wired', async () => {
    const req = {
      socket: { remoteAddress: '192.168.1.20' },
      headers: { cookie: 'nuncio_token=secret' },
    };
    expect(await isAuthorizedTerminalUpgrade(req)).toBe(false);
  });

  it('accepts a remote upgrade carrying a valid nd1 device bearer', async () => {
    const req = {
      socket: { remoteAddress: '192.168.1.20' },
      headers: { authorization: 'Bearer nd1.dev1.good' },
    };
    expect(await isAuthorizedTerminalUpgrade(req, tokens, undefined, devices)).toBe(true);
  });

  it('refuses an nd1 device bearer whose secret no longer verifies (revoked/rotated-out)', async () => {
    const req = {
      socket: { remoteAddress: '192.168.1.20' },
      headers: { authorization: 'Bearer nd1.dev1.stale' },
    };
    expect(await isAuthorizedTerminalUpgrade(req, tokens, undefined, devices)).toBe(false);
  });

  it('ignores the device branch entirely when no device validator is wired', async () => {
    const req = {
      socket: { remoteAddress: '192.168.1.20' },
      headers: { authorization: 'Bearer nd1.dev1.good' },
    };
    expect(await isAuthorizedTerminalUpgrade(req, tokens)).toBe(false);
  });
});
