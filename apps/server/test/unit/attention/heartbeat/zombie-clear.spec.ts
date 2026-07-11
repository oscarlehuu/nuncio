import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../../src/db/database.module';
import { AttentionRepository } from '../../../../src/attention/attention.repository';
import { AttentionService } from '../../../../src/attention/attention.service';
import { HeartbeatService } from '../../../../src/attention/heartbeat/heartbeat.service';
import { InfraChecks } from '../../../../src/attention/heartbeat/infra-checks';

/**
 * A zombie-session item must clear once its session leaves RUNNING-and-stale
 * (finding #3): the infra check only enumerates CURRENT running sessions, so a
 * finished session emits no OK signal — a registered zombie probe lets
 * reconcileOpenItems auto-resolve the stale item.
 */
describe('zombie item auto-clear', () => {
  let module: TestingModule;
  let attention: AttentionService;
  let heartbeat: HeartbeatService;
  let dataDir: string;
  let now = 5_000_000;

  const sessionRows = new Map<string, { id: string; status: string; createdAt: number }>();
  const eventAt = new Map<string, number>();
  const fakeSessions = {
    list: () => [...sessionRows.values()],
    listUserFacing: () => [...sessionRows.values()],
    findById: (id: string) => sessionRows.get(id) ?? null,
  };
  const fakeEvents = { latestEventAt: (id: string) => eventAt.get(id) ?? null };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-zombie-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    sessionRows.clear();
    eventAt.clear();
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [AttentionRepository, AttentionService, InfraChecks],
    }).compile();
    attention = module.get(AttentionService);
    const infra = module.get(InfraChecks);
    infra.zombieAgeMs = 30 * 60 * 1000;

    heartbeat = new HeartbeatService(
      undefined, // scheduler (no ensure in this spec)
      undefined, // settings
      attention,
      undefined, // loops
      infra,
      undefined, // digests
      undefined, // push
      undefined, // database
      undefined, // forges
      fakeSessions as never,
      fakeEvents as never,
    );
    heartbeat.clock = { now: () => now };
    infra.clock = { now: () => now };
    // Register the zombie probe (+ session/forge seams) without ensureSchedules.
    (heartbeat as unknown as { bindInfraProbes: () => void }).bindInfraProbes();
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('clears the zombie item once the session finishes (no longer RUNNING)', () => {
    // A stale RUNNING session → raise a zombie item (as the infra fold would).
    sessionRows.set('s1', { id: 's1', status: 'RUNNING', createdAt: 0 });
    eventAt.set('s1', now - 40 * 60 * 1000); // 40 min ago → stale
    attention.raise({ kind: 'zombie-session', subjectId: 'session:s1', title: 'silent', payload: { sessionId: 's1' } });
    expect(attention.list().items.some((i) => i.subjectId === 'session:s1')).toBe(true);

    // The session finishes → probe reports the condition cleared → reconcile resolves.
    sessionRows.set('s1', { id: 's1', status: 'IDLE', createdAt: 0 });
    attention.reconcileOpenItems();
    expect(attention.list().items.some((i) => i.subjectId === 'session:s1')).toBe(false);
  });

  it('keeps the zombie item while the session is STILL running-and-stale', () => {
    sessionRows.set('s2', { id: 's2', status: 'RUNNING', createdAt: 0 });
    eventAt.set('s2', now - 40 * 60 * 1000);
    attention.raise({ kind: 'zombie-session', subjectId: 'session:s2', title: 'silent', payload: { sessionId: 's2' } });
    attention.reconcileOpenItems();
    expect(attention.list().items.some((i) => i.subjectId === 'session:s2')).toBe(true);
  });
});
