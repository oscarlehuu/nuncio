import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { PushRepository } from '../../../src/push/push.repository';
import { pushContentFor, PushService, type PushMessage } from '../../../src/push/push.service';

let db: DatabaseService;
let dataDir: string;
let sent: PushMessage[][];
let service: PushService;

function seedSession(id: string, title: string, verifyOwner: 'session' = 'session') {
  db.db
    .prepare(
      `INSERT INTO sessions (id, title, prompt, verify_owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, title, 'prompt', verifyOwner, Date.now(), Date.now());
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nuncio-push-'));
  process.env.NUNCIO_DATA_DIR = dataDir;
  db = new DatabaseService();
  sent = [];
  service = new PushService(new PushRepository(db), db);
  service.setTransport(async (messages) => {
    sent.push(messages);
  });
  service.onModuleInit();
});

afterEach(() => {
  service.onModuleDestroy();
  db.onModuleDestroy();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.NUNCIO_DATA_DIR;
});

describe('pushContentFor', () => {
  const at = { seq: 1, createdAt: 0 };

  it('pushes on IDLE, ERROR, and user_input_requested — nothing else', () => {
    expect(pushContentFor({ ...at, type: 'status', payload: { status: 'IDLE' } }, 'T')?.title).toBe(
      'Agent finished',
    );
    expect(pushContentFor({ ...at, type: 'status', payload: { status: 'ERROR' } }, 'T')?.title).toBe(
      'Session error',
    );
    expect(pushContentFor({ ...at, type: 'user_input_requested', payload: {} }, 'T')?.title).toBe(
      'Agent needs your input',
    );
    expect(pushContentFor({ ...at, type: 'status', payload: { status: 'RUNNING' } }, 'T')).toBeNull();
    expect(pushContentFor({ ...at, type: 'assistant_message', payload: {} }, 'T')).toBeNull();
  });
});

describe('PushService', () => {
  it('registration upserts and unregister removes the token', () => {
    service.register('ExponentPushToken[a]', 'ios', 'Phone');
    service.register('ExponentPushToken[a]', 'ios', 'Phone renamed');
    const repo = new PushRepository(db);
    expect(repo.list()).toHaveLength(1);
    expect(repo.list()[0].deviceName).toBe('Phone renamed');
    service.unregister('ExponentPushToken[a]');
    expect(repo.list()).toHaveLength(0);
  });

  it('sends a push to every registered device when a session goes IDLE via the event log', () => {
    seedSession('s1', 'Fix the login bug');
    service.register('ExponentPushToken[a]', 'ios');
    service.register('ExponentPushToken[b]', 'android');

    const events = new EventsRepository(db);
    events.append('s1', 'status', { status: 'IDLE' });

    // The hook fires synchronously into an async send; flush microtasks.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(sent).toHaveLength(1);
        expect(sent[0].map((m) => m.to).sort()).toEqual([
          'ExponentPushToken[a]',
          'ExponentPushToken[b]',
        ]);
        expect(sent[0][0]).toMatchObject({
          title: 'Agent finished',
          body: 'Fix the login bug',
          data: { sessionId: 's1' },
        });
        resolve();
      }, 10);
    });
  });

  it('stays silent for non-lifecycle events and when no device is registered', async () => {
    seedSession('s1', 'T');
    const events = new EventsRepository(db);
    events.append('s1', 'assistant_message', { text: 'hi' });
    events.append('s1', 'status', { status: 'IDLE' }); // no tokens registered
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(0);
  });
});
