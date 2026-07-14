import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { AuthController } from '../../../src/auth/auth.controller';
import { AUTH_COOKIE_NAME } from '../../../src/auth/auth-request';

describe('AuthController', () => {
  function controllerFor(opts: {
    validToken?: string;
    trustedRemote?: boolean;
    authorized?: boolean;
  } = {}) {
    const validToken = opts.validToken ?? 'secret-token';
    const cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
    const tokens = {
      token: validToken,
      source: '/data/auth.token',
      isValidToken: (value: string) => value === validToken,
    };
    const tailscale = {
      isTrustedRemote: async () => opts.trustedRemote ?? false,
    };
    const controller = new AuthController(tokens as never, tailscale as never);
    const res = {
      cookie(name: string, value: string, options: Record<string, unknown>) {
        cookies.push({ name, value, options });
      },
    };
    return { controller, cookies, res, tokens };
  }

  it('sets the HttpOnly auth cookie on successful login', () => {
    const { controller, cookies, res } = controllerFor();
    expect(controller.login({ token: '  secret-token  ' }, { secure: true }, res)).toEqual({ ok: true });
    expect(cookies).toEqual([
      {
        name: AUTH_COOKIE_NAME,
        value: 'secret-token',
        options: {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: 365 * 24 * 60 * 60 * 1000,
          secure: true,
        },
      },
    ]);
  });

  it('rejects login with an invalid or non-string token', () => {
    const { controller, res } = controllerFor();
    expect(() => controller.login({ token: 'wrong' }, {}, res)).toThrow(UnauthorizedException);
    expect(() => controller.login({ token: 123 }, {}, res)).toThrow(UnauthorizedException);
    expect(() => controller.login({}, {}, res)).toThrow(UnauthorizedException);
  });

  it('reports authenticated when bearer token is valid', async () => {
    const { controller } = controllerFor();
    const req = { headers: { authorization: 'Bearer secret-token' } };
    await expect(controller.status(req as never)).resolves.toEqual({ authenticated: true });
  });

  it('reports unauthenticated for invalid bearer and non-trusted remotes', async () => {
    const { controller } = controllerFor({ trustedRemote: false });
    const req = { headers: { authorization: 'Bearer wrong' }, socket: { remoteAddress: '203.0.113.1' } };
    await expect(controller.status(req as never)).resolves.toEqual({ authenticated: false });
  });

  it('reports authenticated for trusted tailnet remotes', async () => {
    const { controller } = controllerFor({ trustedRemote: true });
    await expect(controller.status({ socket: { remoteAddress: '100.64.0.2' } } as never)).resolves.toEqual({
      authenticated: true,
    });
  });

  it('exposes the current token for already-authenticated clients', () => {
    const { controller } = controllerFor();
    expect(controller.token()).toEqual({ token: 'secret-token', source: '/data/auth.token' });
  });
});
