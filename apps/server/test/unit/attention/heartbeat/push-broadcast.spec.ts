import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../../src/db/database.service';
import { PushRepository } from '../../../../src/push/push.repository';
import { PushService, type PushMessage } from '../../../../src/push/push.service';

/**
 * Digest push delivery (rung 3 sub-phase B) — RED until PushService.broadcast is
 * implemented. Verifies the standalone-broadcast payload shape via a transport
 * spy (no session event, just a founder digest).
 */
describe('PushService.broadcast', () => {
  let db: DatabaseService;
  let dataDir: string;
  let sent: PushMessage[][];
  let service: PushService;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-push-broadcast-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    db = new DatabaseService();
    sent = [];
    service = new PushService(new PushRepository(db), db);
    service.setTransport(async (messages) => { sent.push(messages); });
    service.register('ExponentPushToken[abc]', 'ios', 'iPhone');
  });

  afterEach(() => {
    db.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('broadcasts a standalone digest push to every registered device', async () => {
    await service.broadcast({
      title: 'Morning digest',
      body: '3 shipped · 1 needs you · 12 runs',
      data: { slotKey: '2026-07-07:morning' },
    });
    const flat = sent.flat();
    expect(flat).toHaveLength(1);
    expect(flat[0]!.title).toBe('Morning digest');
    expect(flat[0]!.body).toContain('needs you');
    expect(flat[0]!.data.slotKey).toBe('2026-07-07:morning');
    expect(flat[0]!.to).toBe('ExponentPushToken[abc]');
  });

  it('is a no-op (no send) when no device is registered', async () => {
    service.unregister('ExponentPushToken[abc]');
    await service.broadcast({ title: 't', body: 'b' });
    expect(sent.flat()).toHaveLength(0);
  });
});
