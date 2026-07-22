import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../../src/db/database.module';
import { AttentionRepository } from '../../../../src/attention/attention.repository';
import { AttentionService } from '../../../../src/attention/attention.service';
import { DigestRepository } from '../../../../src/attention/heartbeat/digest.repository';
import { HeartbeatService } from '../../../../src/attention/heartbeat/heartbeat.service';
import { InfraChecks } from '../../../../src/attention/heartbeat/infra-checks';
import type { PushService } from '../../../../src/push/push.service';

/**
 * Heartbeat integration over real durable collaborators (rung 3 sub-phase B):
 * infra results fold into the attention queue (raise + auto-resolve, suppression
 * respected); digest is slot-keyed + not double-sent; system schedules ensure once.
 */
describe('HeartbeatService integration', () => {
  let module: TestingModule;
  let heartbeat: HeartbeatService;
  let attention: AttentionService;
  let infra: InfraChecks;
  let digests: DigestRepository;
  let dataDir: string;
  let now = 1_000_000;
  let broadcasts: number;
  let settingsMap: Map<string, string>;

  class SpyScheduler {
    private handler: ((job: string) => unknown) | null = null;
    schedules: Array<{
      id: string; kind: string; spec: string; enabled: boolean;
      target: { kind: string; job?: string };
    }> = [];
    setSystemFireHandler(h: (job: string) => unknown) { this.handler = h; void this.handler; }
    listSchedules() { return this.schedules; }
    create(input: {
      kind: string; spec: string; enabled?: boolean; target: { kind: string; job?: string };
    }) {
      const id = `s${this.schedules.length + 1}`;
      this.schedules.push({
        id, kind: input.kind, spec: input.spec, enabled: input.enabled !== false, target: input.target,
      });
      return { id };
    }
    updateSpec(id: string, kind: 'cron' | 'heartbeat', spec: string) {
      const s = this.schedules.find((x) => x.id === id);
      if (s) { s.kind = kind; s.spec = spec; }
    }
    setEnabled(id: string, enabled: boolean) {
      const s = this.schedules.find((x) => x.id === id);
      if (s) s.enabled = enabled;
      return s;
    }
  }
  let scheduler: SpyScheduler;

  beforeEach(async () => {
    settingsMap = new Map();
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-heartbeat-int-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    scheduler = new SpyScheduler();
    broadcasts = 0;
    const push = { broadcast: async () => { broadcasts += 1; } } as unknown as PushService;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [AttentionRepository, AttentionService, DigestRepository, InfraChecks],
    }).compile();
    attention = module.get(AttentionService);
    infra = module.get(InfraChecks);
    digests = module.get(DigestRepository);
    infra.clock = { now: () => now };

    const settings = { resolve: (k: string) => settingsMap.get(k) };
    heartbeat = new HeartbeatService(
      scheduler as never,
      settings as never,
      attention,
      undefined, // loops
      infra,
      digests,
      push,
      undefined, // database
    );
    heartbeat.clock = { now: () => now };
    // Bind infra probe seams manually (no forge/session graph in this spec).
    infra.connectedForges = async () => [];
    infra.runningSessions = () => [];
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('folds a failing infra check into an attention item, then auto-resolves on pass', async () => {
    infra.connectedForges = async () => [
      { id: 'github', probe: async () => { throw new Error('401'); } },
    ];
    await heartbeat.runInfraChecks();
    expect(attention.list().items.some((i) => i.kind === 'credential-expiring' && i.subjectId === 'forge:github')).toBe(true);

    // Credential valid again → the check passes → the item auto-resolves.
    infra.connectedForges = async () => [{ id: 'github', probe: async () => {} }];
    await heartbeat.runInfraChecks();
    expect(attention.list().items.some((i) => i.subjectId === 'forge:github')).toBe(false);
  });

  it('re-running infra with the same failing condition does NOT stack items (dedup)', async () => {
    infra.connectedForges = async () => [
      { id: 'gitlab', probe: async () => { throw new Error('401'); } },
    ];
    await heartbeat.runInfraChecks();
    await heartbeat.runInfraChecks();
    expect(attention.list().items.filter((i) => i.subjectId === 'forge:gitlab')).toHaveLength(1);
  });

  it('runDigest sends a slot once and never double-sends it (missed-fire catch-up safe)', async () => {
    await heartbeat.runDigest('morning');
    expect(broadcasts).toBe(1);
    const slot = digests.latest()!.slotKey;
    expect(slot.endsWith(':morning')).toBe(true);

    // A second fire of the same slot (e.g. boot catch-up) is a no-op.
    await heartbeat.runDigest('morning');
    expect(broadcasts).toBe(1);
  });

  it('the since-last window is the previous digest window_to (durable delta boundary)', async () => {
    await heartbeat.runDigest('morning');
    const first = digests.latest()!;
    now = now + 12 * 60 * 60 * 1000; // 12h later
    await heartbeat.runDigest('evening');
    const second = digests.findBySlot(digests.latest()!.slotKey)!;
    expect(second.windowFrom).toBe(first.windowTo);
  });

  it('ensureSchedules creates exactly the 4 system jobs once, idempotently', () => {
    heartbeat.ensureSchedules();
    heartbeat.ensureSchedules(); // reboot — must NOT duplicate
    const jobs = scheduler.listSchedules().map((s) => (s.target as { job: string }).job).sort();
    expect(jobs).toEqual(['digest-evening', 'digest-morning', 'infra', 'reconcile']);
  });

  it('the hourly reconcile re-runs the poll collectors (post-boot trip enters the queue) — finding #1', async () => {
    let swept = 0;
    heartbeat.onSweep = async () => { swept += 1; };
    await heartbeat.dispatch('reconcile');
    expect(swept).toBe(1);
  });

  it('ensureSchedules SYNCS an existing job spec when the setting changes — finding #4', () => {
    settingsMap.set('NUNCIO_HEARTBEAT_INFRA_SPEC', 'every:15m');
    heartbeat.ensureSchedules();
    const before = scheduler.schedules.find((s) => s.target.job === 'infra')!;
    expect(before.spec).toBe('every:15m');

    // Founder changes the cadence; next boot must reflect it (not the stale row).
    settingsMap.set('NUNCIO_HEARTBEAT_INFRA_SPEC', 'every:5m');
    heartbeat.ensureSchedules();
    const infraRows = scheduler.schedules.filter((s) => s.target.job === 'infra');
    expect(infraRows).toHaveLength(1); // updated, not duplicated
    expect(infraRows[0]!.spec).toBe('every:5m');
  });

  it.each(['', 'every:0m', 'every:-5m', 'not-a-cadence'])(
    'disables an invalid heartbeat cadence instead of leaving an enabled dead schedule: %p',
    (invalid) => {
      settingsMap.set('NUNCIO_HEARTBEAT_INFRA_SPEC', invalid);
      heartbeat.ensureSchedules();

      const infraSchedule = scheduler.schedules.find((s) => s.target.job === 'infra')!;
      expect(infraSchedule.spec).toBe(invalid);
      expect(infraSchedule.enabled).toBe(false);

      settingsMap.set('NUNCIO_HEARTBEAT_INFRA_SPEC', 'every:5m');
      heartbeat.ensureSchedules();
      expect(infraSchedule).toMatchObject({ spec: 'every:5m', enabled: true });
    },
  );

  it('runDigest reports REAL counts from the bound seam (never fake zeros) — finding #5', async () => {
    heartbeat.gatherDigestCounts = () => ({
      runsOk: 3, runsFailed: 1, prsOpened: 2, attentionRaised: 4, attentionResolved: 2,
      sessionsCompleted: 5, sessionsNeedsYou: 1, runsToday: 9, cap: 24,
    });
    await heartbeat.runDigest('morning');
    const digest = digests.latest()!.digest;
    expect(digest.loops).toEqual({ runsOk: 3, runsFailed: 1, prsOpened: 2 });
    expect(digest.attention.raised).toBe(4);
    expect(digest.attention.resolved).toBe(2);
    expect(digest.sessions).toEqual({ completed: 5, needsYou: 1 });
    expect(digest.budget).toEqual({ runsToday: 9, cap: 24 });
  });
});
