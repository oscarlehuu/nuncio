import { describe, expect, it } from 'bun:test';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AuthGuard } from '../../../src/auth/auth.guard';
import type { AuthTokenService } from '../../../src/auth/auth-token.service';
import type { DevicesService } from '../../../src/devices/devices.service';
import type { TailscaleService } from '../../../src/tailscale/tailscale.service';

const tokens = {
  isValidToken: (candidate: unknown) => candidate === 'secret',
} as unknown as AuthTokenService;

const noTrust = {
  isTrustedRemote: async () => false,
} as unknown as TailscaleService;

const devices = {
  verifyDevice: (id: string, secret: string) => id === 'dev1' && secret === 'good',
} as unknown as DevicesService;

function guardWith(isPublic: boolean, trust: TailscaleService = noTrust): AuthGuard {
  const reflector = { getAllAndOverride: () => isPublic } as unknown as Reflector;
  return new AuthGuard(reflector, tokens, trust, devices);
}

function httpContext(request: unknown): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  it('lets @Public() routes through without any credentials', async () => {
    const context = httpContext({ socket: { remoteAddress: '203.0.113.7' } });
    expect(await guardWith(true).canActivate(context)).toBe(true);
  });

  it('lets loopback requests through without a token', async () => {
    const context = httpContext({ socket: { remoteAddress: '127.0.0.1' } });
    expect(await guardWith(false).canActivate(context)).toBe(true);
  });

  it('lets remote requests through with a valid cookie or Bearer header', async () => {
    const cookie = httpContext({
      socket: { remoteAddress: '203.0.113.7' },
      headers: { cookie: 'nuncio_token=secret' },
    });
    expect(await guardWith(false).canActivate(cookie)).toBe(true);

    const bearer = httpContext({
      socket: { remoteAddress: '203.0.113.7' },
      headers: { authorization: 'Bearer secret' },
    });
    expect(await guardWith(false).canActivate(bearer)).toBe(true);
  });

  it('lets a trusted tailnet peer through without a token', async () => {
    const trust = {
      isTrustedRemote: async (addr: unknown) => addr === '100.105.188.11',
    } as unknown as TailscaleService;
    const context = httpContext({ socket: { remoteAddress: '100.105.188.11' } });
    expect(await guardWith(false, trust).canActivate(context)).toBe(true);
  });

  it('lets a remote request through with a valid nd1 device bearer', async () => {
    const context = httpContext({
      socket: { remoteAddress: '203.0.113.7' },
      headers: { authorization: 'Bearer nd1.dev1.good' },
    });
    expect(await guardWith(false).canActivate(context)).toBe(true);
  });

  it('throws 401 for a device bearer whose secret no longer verifies', async () => {
    const context = httpContext({
      socket: { remoteAddress: '203.0.113.7' },
      headers: { authorization: 'Bearer nd1.dev1.stale' },
    });
    await expect(guardWith(false).canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('a presented device credential decides: an invalid nd1 bearer 401s even with a valid cookie', async () => {
    const context = httpContext({
      socket: { remoteAddress: '203.0.113.7' },
      headers: { authorization: 'Bearer nd1.dev1.stale', cookie: 'nuncio_token=secret' },
    });
    await expect(guardWith(false).canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('a valid nd1 bearer authorizes even when a valid cookie is also present', async () => {
    const context = httpContext({
      socket: { remoteAddress: '203.0.113.7' },
      headers: { authorization: 'Bearer nd1.dev1.good', cookie: 'nuncio_token=secret' },
    });
    expect(await guardWith(false).canActivate(context)).toBe(true);
  });

  it('does not let a revoked device bearer fall through to a trusted tailnet identity', async () => {
    const trust = {
      isTrustedRemote: async () => true,
    } as unknown as TailscaleService;
    const context = httpContext({
      socket: { remoteAddress: '100.105.188.11' },
      headers: { authorization: 'Bearer nd1.dev1.stale' },
    });
    await expect(guardWith(false, trust).canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('401s a malformed nd1 bearer + valid cookie (malforming the header cannot pick the fallback)', async () => {
    for (const bad of ['Bearer nd1.onlyonepart', 'Bearer nd1.a.b.c', 'Bearer nd1.dev!1.good']) {
      const context = httpContext({
        socket: { remoteAddress: '203.0.113.7' },
        headers: { authorization: bad, cookie: 'nuncio_token=secret' },
      });
      await expect(guardWith(false).canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });

  it('401s a malformed nd1 bearer even from a trusted tailnet address', async () => {
    const trust = {
      isTrustedRemote: async () => true,
    } as unknown as TailscaleService;
    const context = httpContext({
      socket: { remoteAddress: '100.105.188.11' },
      headers: { authorization: 'Bearer nd1.a.b.c' },
    });
    await expect(guardWith(false, trust).canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('leaves the none path intact: a plain global Bearer token (no dots) still authorizes', async () => {
    const context = httpContext({
      socket: { remoteAddress: '203.0.113.7' },
      headers: { authorization: 'Bearer secret' },
    });
    expect(await guardWith(false).canActivate(context)).toBe(true);
  });

  it('throws 401 for remote requests without a valid token or trusted identity', async () => {
    const context = httpContext({
      socket: { remoteAddress: '203.0.113.7' },
      headers: { cookie: 'nuncio_token=wrong' },
    });
    await expect(guardWith(false).canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
