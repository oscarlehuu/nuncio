import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthTokenService } from '../auth/auth-token.service';
import { DevicesService } from '../devices/devices.service';

export type ConnectionTicketScope = 'relay:endpoints' | 'sessions:ws';

export interface ConnectionTicketVerifier {
  verify(ticket: string, requiredScope: ConnectionTicketScope): { deviceId: string } | null;
}

interface TicketPayload {
  v: 1;
  sub: string;
  aud: 'nuncio-relay';
  scope: ConnectionTicketScope[];
  iat: number;
  exp: number;
  nonce: string;
}

const PREFIX = 'rt1';
const AUDIENCE = 'nuncio-relay';
const SIGNING_CONTEXT = 'nuncio:relay-ticket:v1';
const TICKET_TTL_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SCOPES: ConnectionTicketScope[] = ['relay:endpoints', 'sessions:ws'];

@Injectable()
export class ConnectionTicketService {
  private now: () => number = () => Date.now();

  constructor(
    private readonly tokens: AuthTokenService,
    private readonly devices: DevicesService,
  ) {}

  setClock(now: () => number): void {
    this.now = now;
  }

  mint(deviceId: string): { ticket: string; expiresAt: number } {
    const issuedAt = this.now();
    const expiresAt = issuedAt + TICKET_TTL_MS;
    const payload: TicketPayload = {
      v: 1,
      sub: deviceId,
      aud: AUDIENCE,
      scope: SCOPES,
      iat: issuedAt,
      exp: expiresAt,
      nonce: randomBytes(12).toString('base64url'),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { ticket: `${PREFIX}.${encoded}.${this.sign(encoded)}`, expiresAt };
  }

  verify(ticket: string, requiredScope: ConnectionTicketScope): { deviceId: string } | null {
    const parts = ticket.split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) return null;
    const [, encoded, signature] = parts;
    if (!encoded || !signature || !BASE64URL.test(encoded) || !BASE64URL.test(signature)) return null;
    const expected = Buffer.from(this.sign(encoded));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    let payload: Partial<TicketPayload>;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<TicketPayload>;
    } catch {
      return null;
    }
    const now = this.now();
    if (
      payload.v !== 1 ||
      payload.aud !== AUDIENCE ||
      typeof payload.sub !== 'string' ||
      !BASE64URL.test(payload.sub) ||
      !Array.isArray(payload.scope) ||
      !payload.scope.includes(requiredScope) ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.exp - payload.iat !== TICKET_TTL_MS ||
      payload.iat > now + MAX_CLOCK_SKEW_MS ||
      now >= payload.exp ||
      !this.devices.isActive(payload.sub)
    ) {
      return null;
    }
    return { deviceId: payload.sub };
  }

  private sign(encodedPayload: string): string {
    const key = createHmac('sha256', this.tokens.token).update(SIGNING_CONTEXT).digest();
    return createHmac('sha256', key)
      .update(`${PREFIX}.${encodedPayload}`)
      .digest('base64url');
  }
}
