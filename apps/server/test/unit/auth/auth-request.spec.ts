import { describe, expect, it } from 'bun:test';
import {
  bearerToken,
  cookieToken,
  isAuthorizedRequest,
  type TokenValidator,
} from '../../../src/auth/auth-request';

const tokens: TokenValidator = {
  isValidToken: (candidate) => candidate === 'secret',
};

describe('bearerToken', () => {
  it('extracts the token from a Bearer header, case-insensitively', () => {
    expect(bearerToken('Bearer secret')).toBe('secret');
    expect(bearerToken('bearer secret')).toBe('secret');
    expect(bearerToken('  Bearer   secret  ')).toBe('secret');
  });

  it('returns null for missing or non-bearer headers', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
  });
});

describe('cookieToken', () => {
  it('finds the nuncio_token cookie among others', () => {
    expect(cookieToken('nuncio_token=secret')).toBe('secret');
    expect(cookieToken('a=1; nuncio_token=secret; b=2')).toBe('secret');
  });

  it('decodes url-encoded values', () => {
    expect(cookieToken('nuncio_token=se%2Fcret')).toBe('se/cret');
  });

  it('returns null when absent or malformed', () => {
    expect(cookieToken(undefined)).toBeNull();
    expect(cookieToken('')).toBeNull();
    expect(cookieToken('other=1')).toBeNull();
    expect(cookieToken('nuncio_token_extra=1')).toBeNull();
  });
});

describe('isAuthorizedRequest', () => {
  it('always trusts loopback connections', () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(isAuthorizedRequest({ socket: { remoteAddress: addr } }, tokens)).toBe(true);
    }
  });

  it('accepts a remote request with a valid Bearer header', () => {
    const req = {
      socket: { remoteAddress: '192.168.1.20' },
      headers: { authorization: 'Bearer secret' },
    };
    expect(isAuthorizedRequest(req, tokens)).toBe(true);
  });

  it('accepts a remote request with a valid auth cookie', () => {
    const req = {
      socket: { remoteAddress: '192.168.1.20' },
      headers: { cookie: 'nuncio_token=secret' },
    };
    expect(isAuthorizedRequest(req, tokens)).toBe(true);
  });

  it('rejects remote requests with a wrong or missing token', () => {
    const remote = { remoteAddress: '203.0.113.7' };
    expect(isAuthorizedRequest({ socket: remote }, tokens)).toBe(false);
    expect(
      isAuthorizedRequest({ socket: remote, headers: { authorization: 'Bearer nope' } }, tokens),
    ).toBe(false);
    expect(
      isAuthorizedRequest({ socket: remote, headers: { cookie: 'nuncio_token=nope' } }, tokens),
    ).toBe(false);
  });
});
