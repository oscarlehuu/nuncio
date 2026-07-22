import { describe, expect, it } from 'bun:test';
import { PairingService } from '../../../src/pairing/pairing.service';

describe('PairingService', () => {
  it('mints a code that consumes exactly once (single-use)', () => {
    const pairing = new PairingService();
    const { code } = pairing.start();
    expect(pairing.consume(code)).toBe(true);
    expect(pairing.consume(code)).toBe(false);
  });

  it('rejects a wrong or non-string candidate', () => {
    const pairing = new PairingService();
    pairing.start();
    expect(pairing.consume('wrong')).toBe(false);
    expect(pairing.consume(undefined)).toBe(false);
    expect(pairing.consume(123)).toBe(false);
  });

  it('rejects an expired code after the TTL', () => {
    let now = 0;
    const pairing = new PairingService();
    pairing.setClock(() => now);
    const { code } = pairing.start();
    now += 5 * 60_000; // exactly at expiry — expiresAt is now, so >= means expired
    expect(pairing.consume(code)).toBe(false);
  });

  it('a new start invalidates the previous code', () => {
    const pairing = new PairingService();
    const first = pairing.start().code;
    const second = pairing.start().code;
    expect(pairing.consume(first)).toBe(false);
    expect(pairing.consume(second)).toBe(true);
  });

  it('consume with no active code returns false', () => {
    const pairing = new PairingService();
    expect(pairing.consume('anything')).toBe(false);
  });

  it('reserves one overlapping claim and rolls it back for exactly one retry', () => {
    const pairing = new PairingService();
    const code = pairing.start().code;
    const reservation = pairing.reserve(code);
    expect(reservation).not.toBeNull();
    expect(pairing.reserve(code)).toBeNull();

    expect(pairing.rollback(reservation!)).toBe(true);
    const retry = pairing.reserve(code);
    expect(retry).not.toBeNull();
    expect(pairing.commit(retry!)).toBe(true);
    expect(pairing.reserve(code)).toBeNull();
  });

  it('does not let a stale rollback revive a code replaced by start', () => {
    const pairing = new PairingService();
    const first = pairing.start().code;
    const reservation = pairing.reserve(first)!;
    const second = pairing.start().code;

    expect(pairing.rollback(reservation)).toBe(false);
    expect(pairing.consume(first)).toBe(false);
    expect(pairing.consume(second)).toBe(true);
  });

  it('does not reopen a reservation rolled back exactly at expiry', () => {
    let now = 0;
    const pairing = new PairingService();
    pairing.setClock(() => now);
    const code = pairing.start().code;
    const reservation = pairing.reserve(code)!;
    now = 5 * 60_000;

    expect(pairing.rollback(reservation)).toBe(false);
    expect(pairing.consume(code)).toBe(false);
  });
});
