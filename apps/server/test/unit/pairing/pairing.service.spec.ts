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
});
