import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../../../src/db/database.service';
import { WebhookDeliveryTracker } from '../../../src/forges/webhooks/webhook-delivery-tracker';

describe('WebhookDeliveryTracker', () => {
  let dataDir: string;
  let database: DatabaseService;
  let tracker: WebhookDeliveryTracker;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-webhook-delivery-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    database = new DatabaseService();
    tracker = new WebhookDeliveryTracker(database);
  });

  afterEach(() => {
    database.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('dedupes active and completed claims but permits an explicitly released retry', () => {
    const firstResult = tracker.claim('github', 'delivery-1');
    expect(firstResult.status).toBe('claimed');
    if (firstResult.status !== 'claimed') throw new Error('expected first claim');
    const first = firstResult.claim;
    expect(tracker.renew(first)).toBe(true);
    expect(tracker.claim('github', 'delivery-1')).toEqual({ status: 'in-progress' });

    tracker.markCheckpoint(first, 'merge-cleanup-authorized');
    tracker.release(first);
    const retryResult = tracker.claim('github', 'delivery-1');
    expect(retryResult.status).toBe('claimed');
    if (retryResult.status !== 'claimed') throw new Error('expected retry claim');
    const retry = retryResult.claim;
    expect(retry.token).not.toBe(first.token);
    expect(retry.checkpoint).toBe('merge-cleanup-authorized');
    expect(tracker.complete(retry, () => 'accepted')).toBe('accepted');
    expect(tracker.claim('github', 'delivery-1')).toEqual({ status: 'completed' });
  });

  it('rolls back durable work and leaves the claim releasable when completion fails', () => {
    const claimed = tracker.claim('gitlab', 'delivery-2');
    const claim = claimed.status === 'claimed' ? claimed.claim : null;
    expect(claim).not.toBeNull();

    expect(() => tracker.complete(claim!, () => {
      database.db
        .prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)')
        .run('webhook-acceptance', 'partial', Date.now());
      throw new Error('terminal write failed');
    })).toThrow('terminal write failed');
    expect(database.db.prepare('SELECT value FROM preferences WHERE key = ?')
      .get('webhook-acceptance')).toBeNull();

    tracker.release(claim!);
    expect(tracker.claim('gitlab', 'delivery-2').status).toBe('claimed');
  });

  it('preserves a reserved session id when a released delivery is reclaimed', () => {
    const firstResult = tracker.claim('github', 'issue-delivery');
    if (firstResult.status !== 'claimed') throw new Error('expected first claim');

    const reservedId = tracker.reserveSessionId(firstResult.claim);
    expect(reservedId).toHaveLength(8);
    expect(tracker.reserveSessionId(firstResult.claim)).toBe(reservedId);

    tracker.release(firstResult.claim);
    const retryResult = tracker.claim('github', 'issue-delivery');
    if (retryResult.status !== 'claimed') throw new Error('expected retry claim');

    expect(retryResult.claim.sessionId).toBe(reservedId);
    expect(tracker.reserveSessionId(retryResult.claim)).toBe(reservedId);
  });
});
