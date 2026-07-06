import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

/**
 * Restart-safety + provider-agnosticism + priority rules for the verify-feedback
 * loop. The retry-round count is DERIVED FROM THE EVENT LOG (ADR-006 append-only
 * log; product-vision restart test), so a daemon replacement mid-retry must
 * rebuild the exact count. RED until the loop exists.
 */

const AUTO_STEER = 'NUNCIO_VERIFY_AUTO_STEER';
const MAX_ROUNDS = 'NUNCIO_VERIFY_MAX_ROUNDS';

// Loops that fail every round + a restart take longer than Bun's 5s default;
// give the harness headroom so an unbuilt feature fails on an assertion (or the
// internal wait's own throw), not a bare harness timeout.
const TEST_TIMEOUT_MS = 30000;

function eventsOfType(events: SessionEvent[], type: string): SessionEvent[] {
  return events.filter((e) => e.type === type);
}

function writeAlwaysFailScript(workspace: string, output: string): void {
  mkdirSync(join(workspace, '.nuncio'), { recursive: true });
  writeFileSync(join(workspace, '.nuncio', 'verify'), `echo "${output}" >&2\nexit 1\n`);
}

/** A verify script that spawns a command that does not exist — the run throws. */
function writeCrashingVerifyScript(workspace: string): void {
  mkdirSync(join(workspace, '.nuncio'), { recursive: true });
  writeFileSync(
    join(workspace, '.nuncio', 'verify'),
    'this-binary-does-not-exist-nuncio 2>/dev/null || exit 127\n',
  );
}

async function buildCursorModule(): Promise<TestingModule> {
  return withSimulatedCursorProvider(
    Test.createTestingModule({
      imports: [
        DatabaseModule,
        SettingsModule,
        SessionsPersistenceModule,
        AgentsModule,
        GitModule,
        CursorLocalModule,
      ],
      providers: [SessionsService],
    }),
  ).compile();
}

async function waitFor(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within timeout');
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe('verify-feedback loop: restart, priority, provider-agnostic', () => {
  let dataDir: string;
  let workspace: string;
  const priorMockFlag = process.env.NUNCIO_FORCE_MOCK;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-verify-feedback-restart-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-vfr-ws-'));
    process.env[AUTO_STEER] = '1';
    process.env[MAX_ROUNDS] = '3';
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    delete process.env[AUTO_STEER];
    delete process.env[MAX_ROUNDS];
    if (priorMockFlag === undefined) delete process.env.NUNCIO_FORCE_MOCK;
    else process.env.NUNCIO_FORCE_MOCK = priorMockFlag;
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('rebuilds the retry-round count from the event log after a restart', async () => {
    // Cap rounds high so the loop is still mid-flight when we simulate a crash.
    process.env[MAX_ROUNDS] = '6';
    writeAlwaysFailScript(workspace, 'RED: restart mid-retry');

    const first = await buildCursorModule();
    const service = first.get(SessionsService);
    const events = first.get(EventsRepository);
    const session = await service.create({
      prompt: 'restart mid-retry',
      provider: 'cursor',
      workspace,
    });

    // Let at least one retry round land, then simulate the daemon dying.
    await waitFor(() => eventsOfType(events.list(session.id), 'verify_retry').length >= 1);
    const retriesBeforeRestart = eventsOfType(events.list(session.id), 'verify_retry').length;
    await first.close();

    // New daemon: the round counter must come from the durable log, not memory.
    const second = await buildCursorModule();
    const service2 = second.get(SessionsService);
    const events2 = second.get(EventsRepository);

    // The loop must eventually stop at exactly MAX_ROUNDS retries total across
    // both lifetimes — the restart must not reset the count to zero (which would
    // let it loop forever) nor double-count.
    await waitFor(
      () => eventsOfType(events2.list(session.id), 'verify_needs_attention').length === 1,
      20000,
    );
    const totalRetries = eventsOfType(events2.list(session.id), 'verify_retry').length;
    expect(totalRetries).toBe(6);
    expect(totalRetries).toBeGreaterThanOrEqual(retriesBeforeRestart);
    await second.close();
  }, TEST_TIMEOUT_MS);

  it('a verify command that crashes counts as a failed round and still auto-steers, no crash', async () => {
    process.env[MAX_ROUNDS] = '2';
    writeCrashingVerifyScript(workspace);

    const module = await buildCursorModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const session = await service.create({ prompt: 'crashing verify', provider: 'cursor', workspace });

    await waitFor(
      () => eventsOfType(events.list(session.id), 'verify_needs_attention').length === 1,
    );
    const all = events.list(session.id);
    // A crashing verify still produces failing verify_result rows and drives the loop.
    expect(eventsOfType(all, 'verify_result').every((e) => (e.payload as { ok?: boolean }).ok === false)).toBe(true);
    expect(eventsOfType(all, 'verify_retry').length).toBe(2);
    // Service still alive and honest.
    expect(service.get(session.id)?.status).toBe('IDLE');
    await module.close();
  }, TEST_TIMEOUT_MS);

  it('a manual user steer between rounds takes priority and resets the auto-retry counter', async () => {
    process.env[MAX_ROUNDS] = '3';
    writeAlwaysFailScript(workspace, 'RED: keep failing');

    const module = await buildCursorModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const session = await service.create({ prompt: 'human intervenes', provider: 'cursor', workspace });

    // Wait for the first auto-retry, then the founder steers manually.
    await waitFor(() => eventsOfType(events.list(session.id), 'verify_retry').length >= 1);
    await service.awaitRun(session.id);
    await service.steer(session.id, 'try a completely different approach');

    // After the manual steer the loop must run a FRESH budget: the counter reset,
    // so the total retries end at 3 counted AFTER the manual steer boundary, not
    // capped early because earlier auto-retries had already spent the budget.
    await waitFor(
      () => eventsOfType(events.list(session.id), 'verify_needs_attention').length >= 1,
      20000,
    );
    const all = events.list(session.id);
    const manualSteerSeq = all.find(
      (e) => e.type === 'steer_message' &&
        String((e.payload as { text?: string }).text ?? '').includes('completely different approach'),
    )?.seq;
    expect(manualSteerSeq).toBeDefined();
    const retriesAfterManual = all.filter(
      (e) => e.type === 'verify_retry' && e.seq > (manualSteerSeq ?? 0),
    );
    // A full fresh budget ran after the human took over.
    expect(retriesAfterManual.length).toBe(3);
    await module.close();
  }, TEST_TIMEOUT_MS);

  it('drives the whole loop through the mock provider with zero engine-specific branches', async () => {
    process.env.NUNCIO_FORCE_MOCK = '1';
    process.env[MAX_ROUNDS] = '2';
    writeAlwaysFailScript(workspace, 'RED: mock provider path');

    const module = await Test.createTestingModule({
      imports: [
        DatabaseModule,
        SettingsModule,
        SessionsPersistenceModule,
        AgentsModule,
        GitModule,
        CursorLocalModule,
      ],
      providers: [SessionsService],
    }).compile();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);

    const session = await service.create({ prompt: 'mock loop', provider: 'mock', workspace });

    await waitFor(
      () => eventsOfType(events.list(session.id), 'verify_needs_attention').length === 1,
    );
    const all = events.list(session.id);
    expect(eventsOfType(all, 'verify_retry').length).toBe(2);
    // The auto-steer went through the normal steer path, producing steer_messages
    // the mock engine acted on — no cursor/pi-specific code involved.
    expect(eventsOfType(all, 'steer_message').length).toBeGreaterThanOrEqual(2);
    await module.close();
  }, TEST_TIMEOUT_MS);
});
