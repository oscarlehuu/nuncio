import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_TOKEN_FILENAME, AuthTokenService } from '../../../src/auth/auth-token.service';
import type { DatabaseService } from '../../../src/db/database.service';

function serviceFor(dataDir: string): AuthTokenService {
  return new AuthTokenService({ dataDir } as DatabaseService);
}

describe('AuthTokenService', () => {
  let dataDir: string;
  const savedEnv = process.env.NUNCIO_AUTH_TOKEN;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-auth-'));
    delete process.env.NUNCIO_AUTH_TOKEN;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (savedEnv === undefined) {
      delete process.env.NUNCIO_AUTH_TOKEN;
    } else {
      process.env.NUNCIO_AUTH_TOKEN = savedEnv;
    }
  });

  it('generates a token on first use and persists it with owner-only permissions', () => {
    const service = serviceFor(dataDir);
    const token = service.token;

    expect(token.length).toBeGreaterThanOrEqual(24);
    const tokenPath = join(dataDir, AUTH_TOKEN_FILENAME);
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe(token);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(service.source).toBe(tokenPath);
  });

  it('reuses the persisted token across instances', () => {
    const first = serviceFor(dataDir).token;
    const second = serviceFor(dataDir).token;
    expect(second).toBe(first);
  });

  it('trims a hand-written token file', () => {
    writeFileSync(join(dataDir, AUTH_TOKEN_FILENAME), '  my-token \n');
    expect(serviceFor(dataDir).token).toBe('my-token');
  });

  it('prefers NUNCIO_AUTH_TOKEN over the file and does not write one', () => {
    process.env.NUNCIO_AUTH_TOKEN = 'env-token';
    const service = serviceFor(dataDir);
    expect(service.token).toBe('env-token');
    expect(service.source).toBe('NUNCIO_AUTH_TOKEN');
    expect(existsSync(join(dataDir, AUTH_TOKEN_FILENAME))).toBe(false);
  });

  it('validates only the exact token', () => {
    process.env.NUNCIO_AUTH_TOKEN = 'secret-token';
    const service = serviceFor(dataDir);
    expect(service.isValidToken('secret-token')).toBe(true);
    expect(service.isValidToken('secret-token ')).toBe(false);
    expect(service.isValidToken('wrong')).toBe(false);
    expect(service.isValidToken('')).toBe(false);
    expect(service.isValidToken(undefined)).toBe(false);
    expect(service.isValidToken(42)).toBe(false);
  });
});
