import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseService } from '../db/database.service';

export const AUTH_TOKEN_FILENAME = 'auth-token';

/**
 * Owns the server's single access token for non-loopback clients.
 * Resolution order: NUNCIO_AUTH_TOKEN env → persisted `<dataDir>/auth-token`
 * → generate one and persist it (0600). Loopback requests never need it.
 */
@Injectable()
export class AuthTokenService {
  private cachedToken: string | null = null;
  private cachedSource = '';

  constructor(private readonly database: DatabaseService) {}

  get token(): string {
    this.resolve();
    return this.cachedToken as string;
  }

  /** Where the active token came from — the env var name or the token file path. */
  get source(): string {
    this.resolve();
    return this.cachedSource;
  }

  isValidToken(candidate: unknown): boolean {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return false;
    }
    // Hash both sides so timingSafeEqual gets equal-length buffers and the
    // comparison stays constant-time regardless of candidate length.
    const expected = createHash('sha256').update(this.token).digest();
    const actual = createHash('sha256').update(candidate).digest();
    return timingSafeEqual(expected, actual);
  }

  private resolve(): void {
    if (this.cachedToken) {
      return;
    }

    const fromEnv = process.env.NUNCIO_AUTH_TOKEN?.trim();
    if (fromEnv) {
      this.cachedToken = fromEnv;
      this.cachedSource = 'NUNCIO_AUTH_TOKEN';
      return;
    }

    const tokenPath = join(this.database.dataDir, AUTH_TOKEN_FILENAME);
    if (existsSync(tokenPath)) {
      const stored = readFileSync(tokenPath, 'utf8').trim();
      if (stored) {
        this.cachedToken = stored;
        this.cachedSource = tokenPath;
        return;
      }
    }

    const generated = randomBytes(24).toString('base64url');
    writeFileSync(tokenPath, `${generated}\n`, { mode: 0o600 });
    this.cachedToken = generated;
    this.cachedSource = tokenPath;
  }
}
