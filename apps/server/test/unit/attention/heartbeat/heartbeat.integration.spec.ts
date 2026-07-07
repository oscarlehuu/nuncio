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

  class SpyScheduler {
    private handler: ((job: string) => unknown) | null = null;
    private schedules: Array<{ target: { kind: string; job?: string } }> = [];
    setSystemFireHandler(h: (job: string) => unknown) { this.handler = h; void this.handler; }
    listSchedules() { return this.schedules; }
    create(input: { target: { kind: string; job?: string } }) {
      this.schedules.push({ target: input.target });
      return { id: `s${this.schedules.length}` };
    }
  }
  let scheduler: SpyScheduler;

  beforeEach(async () => {
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

    heartbeat = new HeartbeatService(
      scheduler as never,
      undefined, // settings
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
});
