import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DeviceValidator } from '../auth/device-token';
import { DevicesRepository, type DeviceRow } from './devices.repository';

/** Minimum gap between last-seen writes so a busy device is not a write per request. */
const LAST_SEEN_THROTTLE_MS = 60_000;

export interface CreatedDevice {
  id: string;
  secret: string;
}

export interface DeviceSummary {
  id: string;
  name: string;
  platform: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  revoked: boolean;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Constant-time compare of a candidate secret against a stored sha256-hex hash.
 * Both sides are re-hashed to equal-length buffers so timingSafeEqual never
 * short-circuits on length and the comparison stays constant-time regardless of
 * candidate shape. A null stored hash (no prev generation) is always a miss.
 */
function secretMatches(candidate: string, storedHashHex: string | null): boolean {
  if (!storedHashHex) {
    return false;
  }
  const expected = Buffer.from(storedHashHex, 'hex');
  const actual = createHash('sha256').update(candidate).digest();
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

export type RevokeListener = (deviceId: string) => void;

@Injectable()
export class DevicesService implements DeviceValidator {
  private readonly revokeListeners = new Set<RevokeListener>();

  constructor(private readonly devices: DevicesRepository) {}

  /**
   * Subscribes to device revocations. Fired after a device is revoked so live
   * consumers (WS servers) can sever the connections that device authorized —
   * revocation must reach open sockets, not just future upgrades. Returns an
   * unsubscribe to avoid leaking the listener when the consumer tears down.
   */
  onRevoke(listener: RevokeListener): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  /** Mints a device with a fresh 32-byte secret; the raw secret is returned exactly once. */
  create(name: string, platform?: string): CreatedDevice {
    const id = randomBytes(8).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    this.devices.insert({
      id,
      name,
      platform: platform ?? null,
      secretHash: sha256Hex(secret),
      createdAt: Date.now(),
    });
    return { id, secret };
  }

  /**
   * Authorizes a device id + secret. Revoked devices always fail. A match on the
   * current secret while a prev generation is still set confirms the rotation and
   * clears prev; a match on prev is the one-generation grace (prev stays until the
   * new secret is first used). Any successful match touches last-seen (throttled).
   */
  verifyDevice(deviceId: string, secret: string): boolean {
    if (typeof deviceId !== 'string' || typeof secret !== 'string' || !secret) {
      return false;
    }
    const row = this.devices.findById(deviceId);
    if (!row || row.revoked_at !== null) {
      return false;
    }

    if (secretMatches(secret, row.secret_hash)) {
      if (row.prev_secret_hash !== null) {
        this.devices.clearPrevSecret(deviceId);
      }
      this.maybeTouch(row);
      return true;
    }

    if (secretMatches(secret, row.prev_secret_hash)) {
      this.maybeTouch(row);
      return true;
    }

    return false;
  }

  /** Read-only revocation check for short-lived credentials bound to a device id. */
  isActive(deviceId: string): boolean {
    const row = this.devices.findById(deviceId);
    return row !== null && row.revoked_at === null;
  }

  /**
   * Rotates the calling device's secret. `prev` is set to the secret that just
   * authenticated (not any newer unclaimed one), so a client that rotated but
   * never persisted the result can still rotate again from its old secret — one
   * valid old generation, never a lockout. Returns the new raw secret once.
   */
  rotate(deviceId: string, authedSecret: string): CreatedDevice | null {
    const row = this.devices.findById(deviceId);
    if (!row || row.revoked_at !== null) {
      return null;
    }
    const newSecret = randomBytes(32).toString('base64url');
    this.devices.setSecret(deviceId, sha256Hex(newSecret), sha256Hex(authedSecret));
    return { id: deviceId, secret: newSecret };
  }

  revoke(id: string): boolean {
    const row = this.devices.findById(id);
    if (!row) {
      return false;
    }
    this.devices.revoke(id, Date.now());
    for (const listener of this.revokeListeners) {
      try {
        listener(id);
      } catch {
        // A misbehaving listener must not abort the revoke or other listeners.
      }
    }
    return true;
  }

  list(): DeviceSummary[] {
    return this.devices.list().map((row) => this.toSummary(row));
  }

  private toSummary(row: DeviceRow): DeviceSummary {
    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      revoked: row.revoked_at !== null,
    };
  }

  private maybeTouch(row: DeviceRow): void {
    const now = Date.now();
    if (row.last_seen_at === null || now - row.last_seen_at >= LAST_SEEN_THROTTLE_MS) {
      this.devices.touchLastSeen(row.id, now);
    }
  }
}
