import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeJwtExpMs,
  decodeKeychainJson,
  readJsonFile,
  refreshOAuthAccessToken,
} from '../../../src/usage/usage-credentials';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('usage credentials helpers', () => {
  it('readJsonFile returns parsed JSON for existing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuncio-usage-json-'));
    const path = join(dir, 'creds.json');
    writeFileSync(path, JSON.stringify({ token: 'abc' }), 'utf8');
    await expect(readJsonFile(path)).resolves.toEqual({ token: 'abc' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('readJsonFile returns null for missing files', async () => {
    await expect(readJsonFile('/tmp/definitely-missing-usage-json')).resolves.toBeNull();
  });

  it('decodeKeychainJson parses direct JSON and hex-encoded payloads', () => {
    expect(decodeKeychainJson('{"ok":true}')).toEqual({ ok: true });
    const hex = Buffer.from('{"from":"hex"}', 'utf8').toString('hex');
    expect(decodeKeychainJson(hex)).toEqual({ from: 'hex' });
    expect(decodeKeychainJson('not-json')).toBeNull();
  });

  it('decodeJwtExpMs extracts exp from a JWT payload', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const jwt = `header.${payload}.sig`;
    expect(decodeJwtExpMs(jwt)).toBe(1_700_000_000_000);
    expect(decodeJwtExpMs('bad.token')).toBeNull();
  });

  it('refreshOAuthAccessToken returns tokens from a successful refresh', async () => {
    globalThis.fetch = (async () =>
      Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      })) as typeof fetch;

    const result = await refreshOAuthAccessToken({
      refreshUrl: 'https://example.test/token',
      refreshToken: 'old-refresh',
      clientId: 'client-id',
      scope: 'user:profile',
    });

    expect(result).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    expect(result?.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it('refreshOAuthAccessToken returns null on failed refresh', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
    await expect(
      refreshOAuthAccessToken({
        refreshUrl: 'https://example.test/token',
        refreshToken: 'old-refresh',
        clientId: 'client-id',
      }),
    ).resolves.toBeNull();
  });
});
