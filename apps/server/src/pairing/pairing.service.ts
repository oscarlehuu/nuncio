import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Pairing codes live 5 minutes; a stale QR just gets re-opened. */
const CODE_TTL_MS = 5 * 60_000;

export interface ActiveCode {
  code: string;
  expiresAt: number;
}

export interface PairingReservation {
  readonly active: ActiveCode;
  readonly token: symbol;
}

/**
 * Holds at most one active pairing code in memory. `start()` replaces any prior
 * code (a new QR invalidates the old one); claims reserve before device storage
 * and commit only after success. No persistence — a restart drops a pending code,
 * which is fine.
 */
@Injectable()
export class PairingService {
  private active: ActiveCode | null = null;
  private reservation: PairingReservation | null = null;
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
    this.reservation = null;
    return this.active;
  }

  /**
   * Temporarily reserves the current code for one claim. The code remains
   * recoverable until commit, so a downstream device-store failure can roll the
   * reservation back without allowing an overlapping claim to mint a device.
   */
  reserve(candidate: unknown): PairingReservation | null {
    const current = this.active;
    if (!current || this.reservation) return null;
    if (this.now() >= current.expiresAt) {
      this.active = null;
      return null;
    }
    if (typeof candidate !== 'string' || candidate.length === 0) return null;

    const expected = createHash('sha256').update(current.code).digest();
    const actual = createHash('sha256').update(candidate).digest();
    if (!timingSafeEqual(expected, actual)) return null;

    const reservation = { active: current, token: Symbol('pairing-claim') };
    this.reservation = reservation;
    return reservation;
  }

  /** Permanently consume a reservation after its device credential is durable. */
  commit(reservation: PairingReservation): boolean {
    if (this.reservation !== reservation || this.active !== reservation.active) return false;
    this.reservation = null;
    this.active = null;
    return true;
  }

  /**
   * Release a failed claim only when it still owns the current code. A stale
   * rollback can never revive a code replaced by a later start().
   */
  rollback(reservation: PairingReservation): boolean {
    if (this.reservation !== reservation || this.active !== reservation.active) return false;
    this.reservation = null;
    if (this.now() >= reservation.active.expiresAt) {
      this.active = null;
      return false;
    }
    return true;
  }

  /**
   * Backward-compatible one-step consume for callers that have no downstream
   * persistence boundary. A successful consume remains single-use.
   */
  consume(candidate: unknown): boolean {
    const reservation = this.reserve(candidate);
    return reservation ? this.commit(reservation) : false;
  }
}
