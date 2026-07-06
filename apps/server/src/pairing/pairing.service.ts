import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Pairing codes live 5 minutes; a stale QR just gets re-opened. */
const CODE_TTL_MS = 5 * 60_000;

export interface ActiveCode {
  code: string;
  expiresAt: number;
}

/**
 * Holds at most one active pairing code in memory. `start()` replaces any prior
 * code (a new QR invalidates the old one); `consume()` is single-use and
 * constant-time. No persistence — a restart drops a pending code, which is fine.
 */
@Injectable()
export class PairingService {
  private active: ActiveCode | null = null;
  // Overridable clock — production uses Date.now(); tests inject a deterministic
  // one. Not a constructor parameter so Nest's DI never tries to resolve it.
  private now: () => number = () => Date.now();

  /** Test seam — production always uses the real clock. */
  setClock(now: () => number): void {
    this.now = now;
  }

  start(): ActiveCode {
    const code = randomBytes(16).toString('base64url');
    this.active = { code, expiresAt: this.now() + CODE_TTL_MS };
    return this.active;
  }

  /**
   * Validates and consumes a candidate code. Returns true only for the current,
   * unexpired code; a successful consume clears it (single-use). The compare is
   * constant-time over sha256 hashes so a wrong code leaks no timing signal.
   */
  consume(candidate: unknown): boolean {
    const current = this.active;
    if (!current) {
      return false;
    }
    if (this.now() >= current.expiresAt) {
      this.active = null;
      return false;
    }
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return false;
    }
    const expected = createHash('sha256').update(current.code).digest();
    const actual = createHash('sha256').update(candidate).digest();
    if (!timingSafeEqual(expected, actual)) {
      return false;
    }
    this.active = null;
    return true;
  }
}
