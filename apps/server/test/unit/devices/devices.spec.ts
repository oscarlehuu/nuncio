import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { DevicesRepository } from '../../../src/devices/devices.repository';
import { DevicesService } from '../../../src/devices/devices.service';

let db: DatabaseService;
let dataDir: string;
let repo: DevicesRepository;
let service: DevicesService;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nuncio-devices-'));
  process.env.NUNCIO_DATA_DIR = dataDir;
  db = new DatabaseService();
  repo = new DevicesRepository(db);
  service = new DevicesService(repo);
});

afterEach(() => {
  db.onModuleDestroy();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.NUNCIO_DATA_DIR;
});

describe('DevicesService.verifyDevice', () => {
  it('verifies a freshly created device and rejects the wrong secret', () => {
    const { id, secret } = service.create('Phone', 'ios');
    expect(service.verifyDevice(id, secret)).toBe(true);
    expect(service.verifyDevice(id, 'not-the-secret')).toBe(false);
  });

  it('rejects unknown ids, empty secrets, and non-string input without throwing', () => {
    expect(service.verifyDevice('nope', 'x')).toBe(false);
    const { id } = service.create('Phone');
    expect(service.verifyDevice(id, '')).toBe(false);
    expect(service.verifyDevice(id, undefined as unknown as string)).toBe(false);
  });

  it('rejects a revoked device even with the correct secret', () => {
    const { id, secret } = service.create('Phone');
    expect(service.revoke(id)).toBe(true);
    expect(service.verifyDevice(id, secret)).toBe(false);
  });
});

describe('DevicesService rotation state machine', () => {
  it('keeps the old secret valid until the new one is first used, then clears it', () => {
    const { id, secret: original } = service.create('Phone');
    const rotated = service.rotate(id, original);
    expect(rotated).not.toBeNull();
    const next = rotated!.secret;

    // Grace window: both generations verify.
    expect(service.verifyDevice(id, original)).toBe(true);
    expect(repo.findById(id)?.prev_secret_hash).not.toBeNull();

    // First use of the new secret confirms the rotation and drops the grace.
    expect(service.verifyDevice(id, next)).toBe(true);
    expect(repo.findById(id)?.prev_secret_hash).toBeNull();
    expect(service.verifyDevice(id, original)).toBe(false);
  });

  it('double-rotate from the same old secret keeps exactly one valid old generation (no lockout)', () => {
    const { id, secret: original } = service.create('Phone');

    // Client rotates but loses the response (never persists r1's secret).
    const r1 = service.rotate(id, original);
    expect(r1).not.toBeNull();

    // It retries from the ONLY secret it still holds — the original. This authed
    // via prev, so prev must be re-pinned to the original, not r1's unclaimed secret.
    const r2 = service.rotate(id, original);
    expect(r2).not.toBeNull();

    // The original (which just authed the second rotate) is still valid; r2's new
    // secret is valid; r1's dropped secret is not.
    expect(service.verifyDevice(id, r2!.secret)).toBe(true);
    // Re-read: after using r2's secret the grace on `original` is cleared.
    expect(service.verifyDevice(id, original)).toBe(false);
    expect(service.verifyDevice(id, r1!.secret)).toBe(false);
  });

  it('does not rotate a revoked or unknown device', () => {
    const { id, secret } = service.create('Phone');
    service.revoke(id);
    expect(service.rotate(id, secret)).toBeNull();
    expect(service.rotate('unknown', 'x')).toBeNull();
  });
});

describe('DevicesService last-seen throttle', () => {
  it('writes at most once per 60s window', () => {
    const { id, secret } = service.create('Phone');

    // First successful verify stamps last_seen.
    expect(service.verifyDevice(id, secret)).toBe(true);
    const firstSeen = repo.findById(id)?.last_seen_at;
    expect(firstSeen).not.toBeNull();

    // A verify moments later must not re-write within the window.
    expect(service.verifyDevice(id, secret)).toBe(true);
    expect(repo.findById(id)?.last_seen_at).toBe(firstSeen!);

    // Age the stamp past the window; the next verify writes again.
    repo.touchLastSeen(id, firstSeen! - 61_000);
    expect(service.verifyDevice(id, secret)).toBe(true);
    expect(repo.findById(id)?.last_seen_at).toBeGreaterThan(firstSeen! - 61_000);
  });
});

describe('DevicesService.list', () => {
  it('summarizes devices without leaking any hashes and flags revoked ones', () => {
    const a = service.create('Phone A', 'ios');
    service.create('Phone B');
    service.revoke(a.id);

    const summaries = service.list();
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(Object.keys(summary)).toEqual([
        'id',
        'name',
        'platform',
        'createdAt',
        'lastSeenAt',
        'revoked',
      ]);
    }
    expect(summaries.find((s) => s.id === a.id)?.revoked).toBe(true);
  });
});
