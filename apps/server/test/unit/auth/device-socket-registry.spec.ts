import { describe, expect, it } from 'bun:test';
import {
  DeviceSocketRegistry,
  DEVICE_REVOKED_CLOSE_CODE,
  type ClosableSocket,
} from '../../../src/auth/device-socket-registry';

function fakeSocket() {
  const closes: Array<{ code?: number; reason?: string }> = [];
  const socket: ClosableSocket & { closes: typeof closes } = {
    closes,
    close(code, reason) {
      closes.push({ code, reason });
    },
  };
  return socket;
}

describe('DeviceSocketRegistry', () => {
  it('closes only the sockets of the revoked device, with the revoked close code', () => {
    const reg = new DeviceSocketRegistry();
    const a1 = fakeSocket();
    const a2 = fakeSocket();
    const b1 = fakeSocket();
    reg.add('devA', a1);
    reg.add('devA', a2);
    reg.add('devB', b1);

    reg.closeForDevice('devA');

    expect(a1.closes).toHaveLength(1);
    expect(a1.closes[0].code).toBe(DEVICE_REVOKED_CLOSE_CODE);
    expect(a2.closes).toHaveLength(1);
    expect(b1.closes).toHaveLength(0);
  });

  it('is a no-op for a device with no live sockets', () => {
    const reg = new DeviceSocketRegistry();
    expect(() => reg.closeForDevice('ghost')).not.toThrow();
  });

  it('does not close a socket that was already removed (normal close first, then revoke)', () => {
    const reg = new DeviceSocketRegistry();
    const s = fakeSocket();
    reg.add('devA', s);
    reg.remove('devA', s); // socket closed normally, untagged itself

    reg.closeForDevice('devA');
    expect(s.closes).toHaveLength(0);
  });

  it('remove during closeForDevice iteration does not skip or double-close (snapshot)', () => {
    const reg = new DeviceSocketRegistry();
    // Each socket untags itself on close, mutating the set mid-iteration.
    const sockets = [fakeSocket(), fakeSocket(), fakeSocket()];
    for (const s of sockets) {
      reg.add('devA', s);
      const original = s.close.bind(s);
      s.close = (code, reason) => {
        original(code, reason);
        reg.remove('devA', s);
      };
    }

    reg.closeForDevice('devA');
    for (const s of sockets) expect(s.closes).toHaveLength(1);
    // Set is gone entirely; a second revoke is a clean no-op.
    expect(() => reg.closeForDevice('devA')).not.toThrow();
  });
});
