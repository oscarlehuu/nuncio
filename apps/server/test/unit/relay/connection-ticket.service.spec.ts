import { describe, expect, it } from 'bun:test';
import { ConnectionTicketService } from '../../../src/relay/connection-ticket.service';
import type { AuthTokenService } from '../../../src/auth/auth-token.service';
import type { DevicesService } from '../../../src/devices/devices.service';

const SECOND = 1_000;

function makeService(options: { token?: string; active?: (id: string) => boolean } = {}) {
  const tokens = { token: options.token ?? 'persistent-server-secret' };
  const devices = { isActive: options.active ?? ((id: string) => id === 'device-1') };
  const service = new ConnectionTicketService(
    tokens as unknown as AuthTokenService,
    devices as unknown as DevicesService,
  );
  service.setClock(() => 1_700_000_000_000);
  return service;
}

describe('ConnectionTicketService', () => {
  it('signs and verifies a short-lived device-bound ticket for both relay scopes', () => {
    const service = makeService();
    const minted = service.mint('device-1');
    const payload = JSON.parse(
      Buffer.from(minted.ticket.split('.')[1], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(minted.expiresAt).toBe(1_700_000_060_000);
    expect(payload).toEqual({
      v: 1,
      sub: 'device-1',
      aud: 'nuncio-relay',
      scope: ['relay:endpoints', 'sessions:ws'],
      iat: 1_700_000_000_000,
      exp: 1_700_000_060_000,
      nonce: expect.any(String),
    });
    expect(service.verify(minted.ticket, 'relay:endpoints')).toEqual({ deviceId: 'device-1' });
    expect(service.verify(minted.ticket, 'sessions:ws')).toEqual({ deviceId: 'device-1' });
  });

  it('rejects tampering, malformed values, and the wrong signing secret', () => {
    const service = makeService();
    const minted = service.mint('device-1');
    const [prefix, payload, signature] = minted.ticket.split('.');

    expect(service.verify(`${prefix}.${payload}x.${signature}`, 'relay:endpoints')).toBeNull();
    expect(service.verify(`${prefix}.${payload}.${signature}x`, 'relay:endpoints')).toBeNull();
    expect(service.verify('rt1.not-json.bad-signature', 'relay:endpoints')).toBeNull();
    expect(makeService({ token: 'different-secret' }).verify(minted.ticket, 'relay:endpoints')).toBeNull();
  });

  it('expires at the boundary and rejects future-issued tickets', () => {
    const service = makeService();
    const minted = service.mint('device-1');

    service.setClock(() => minted.expiresAt - 1);
    expect(service.verify(minted.ticket, 'relay:endpoints')).not.toBeNull();
    service.setClock(() => minted.expiresAt);
    expect(service.verify(minted.ticket, 'relay:endpoints')).toBeNull();

    const futureVerifier = makeService();
    futureVerifier.setClock(() => 1_700_000_000_000 - 31 * SECOND);
    expect(futureVerifier.verify(minted.ticket, 'relay:endpoints')).toBeNull();
  });

  it('rejects tickets for unknown or revoked devices', () => {
    const issuer = makeService();
    const minted = issuer.mint('device-1');
    const revokedVerifier = makeService({ active: () => false });

    expect(revokedVerifier.verify(minted.ticket, 'relay:endpoints')).toBeNull();
  });
});
