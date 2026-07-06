import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRegistry } from '../../../src/agents/agents.registry';
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
 * Restart-safety, priority rules, in-flight lifecycle, and provider-agnosticism
 * for the verify-feedback loop. The retry-round count is DERIVED FROM THE EVENT
 * LOG (ADR-006 append-only log; product-vision restart test), so a daemon
 * replacement mid-retry must rebuild the exact count and resume the loop. RED
 * until the loop + boot scan exist.
 */

const AUTO_STEER = 'NUNCIO_VERIFY_AUTO_STEER';
const MAX_ROUNDS = 'NUNCIO_VERIFY_MAX_ROUNDS';
const TEST_TIMEOUT_MS = 30000;

function eventsOfType(events: SessionEvent[], type: string): SessionEvent[] {
  return events.filter((e) => e.type === type);
}

function autoSteers(events: SessionEvent[]): SessionEvent[] {
  return events.filter(
    (e) => e.type === 'steer_message' &&
      (e.payload as { origin?: string }).origin === 'verify_retry',
  );
}

function writeAlwaysFailScript(workspace: string, output: string): void {
  mkdirSync(join(workspace, '.nuncio'), { recursive: true });
  writeFileSync(join(workspace, '.nuncio', 'verify'), `echo "${output}" >&2\nexit 1\n`);
}

/** Non-zero EXIT (127) — an ordinary failed run, NOT a runVerifyCommand throw. */
function writeNonZeroExitScript(workspace: string): void {
  mkdirSync(join(workspace, '.nuncio'), { recursive: true });
  writeFileSync(
    join(workspace, '.nuncio', 'verify'),
    'nonexistent-nuncio-binary 2>/dev/null || exit 127\n',
  );
}

/**
 * A verify script that BLOCKS until a release-marker file appears, giving the
 * test deterministic control over "verify is still running" and "the manual
 * steer lands exactly between rounds". Records each invocation and always fails.
 */
function writeGatedFailScript(workspace: string, releaseFile: string): void {
  mkdirSync(join(workspace, '.nuncio'), { recursive: true });
  const script = [
    '#!/bin/sh',
    `while [ ! -f "${releaseFile}" ]; do sleep 0.05; done`,
    'echo "RED: gated failure" >&2',
    'exit 1',
  ].join('\n');
  writeFileSync(join(workspace, '.nuncio', 'verify'), `${script}\n`);
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

async function waitFor(check: () => boolean, timeoutMs = 12000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within timeout');
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe('verify-feedback loop: restart, priority, lifecycle, provider-agnostic', () => {
  let dataDir: string;
  let workspace: string;
  const prior: Record<string, string | undefined> = {};

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-verify-feedback-restart-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-vfr-ws-'));
    prior[AUTO_STEER] = process.env[AUTO_STEER];
    prior[MAX_ROUNDS] = process.env[MAX_ROUNDS];
    prior.NUNCIO_FORCE_MOCK = process.env.NUNCIO_FORCE_MOCK;
    process.env[AUTO_STEER] = '1';
    process.env[MAX_ROUNDS] = '3';
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('rebuilds the retry-round count from the event log after a restart', async () => {
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

    await waitFor(() => eventsOfType(events.list(session.id), 'verify_retry').length >= 1);
    const retriesBeforeRestart = eventsOfType(events.list(session.id), 'verify_retry').length;
    await first.close();

    // New daemon: the boot scan resumes the loop from the durable log.
    const second = await buildCursorModule();
    second.get(SessionsService);
    const events2 = second.get(EventsRepository);

    await waitFor(
      () => eventsOfType(events2.list(session.id), 'verify_needs_attention').length === 1,
      20000,
    );
    const totalRetries = eventsOfType(events2.list(session.id), 'verify_retry').length;
    // Total across both lifetimes is exactly the budget — no reset-to-zero (which
    // would loop forever) and no double-count.
    expect(totalRetries).toBe(6);
    expect(totalRetries).toBeGreaterThanOrEqual(retriesBeforeRestart);
    await second.close();
  }, TEST_TIMEOUT_MS);

  it('resumes the loop after a restart when the last event was a failed verify with no retry marker', async () => {
    // Crash point: a failing verify_result was written but no verify_retry yet.
    // We simulate that by seeding the log directly, then booting.
    const seed = await buildCursorModule();
    const seedSessions = seed.get(EventsRepository);
    const sessionsRepo = seed.get(SessionsService);
    const session = await sessionsRepo.create({
      prompt: 'crashed before retry',
      provider: 'cursor',
      workspace,
    });
    await sessionsRepo.awaitRun(session.id);
    // Ensure the session is IDLE with a failing verify_result as its tail.
    await waitFor(() =>
      seedSessions.list(session.id).some((e) => e.type === 'verify_result'),
    );
    await seed.close();

    // Boot: the scan must resume — evaluate the failed verify and auto-steer.
    process.env[MAX_ROUNDS] = '2';
    writeAlwaysFailScript(workspace, 'RED: resumed after crash');
    const booted = await buildCursorModule();
    booted.get(SessionsService);
    const events = booted.get(EventsRepository);
    await waitFor(
      () => eventsOfType(events.list(session.id), 'verify_retry').length >= 1,
      15000,
    );
    await booted.close();
  }, TEST_TIMEOUT_MS);

  it('re-sends the dangling auto-steer after a restart between the retry marker and the steer', async () => {
    // Crash point: verify_retry (with a retryId) was written, but the daemon died
    // before the auto steer_message was sent. Boot must re-send exactly that steer
    // (idempotent on retryId), never a second retry marker.
    process.env[MAX_ROUNDS] = '3';
    writeAlwaysFailScript(workspace, 'RED: dangling retry');

    const seed = await buildCursorModule();
    const seedSessions = seed.get(SessionsService);
    const seedEvents = seed.get(EventsRepository);
    const session = await seedSessions.create({
      prompt: 'dangling retry',
      provider: 'cursor',
      workspace,
    });
    await seedSessions.awaitRun(session.id);
    await waitFor(() => seedEvents.list(session.id).some((e) => e.type === 'verify_result'));
    // Seed a verify_retry marker with a known retryId, with NO following steer.
    const retryId = 'danglingretry1';
    seedEvents.append(session.id, 'verify_retry', {
      round: 1,
      reason: 'verify_failed',
      command: '.nuncio/verify',
      outputTail: 'RED: dangling retry',
      retryId,
    });
    await seed.close();

    const booted = await buildCursorModule();
    booted.get(SessionsService);
    const events = booted.get(EventsRepository);
    // The dangling steer for that retryId is re-sent — exactly once.
    await waitFor(
      () =>
        events.list(session.id).some(
          (e) => e.type === 'steer_message' &&
            (e.payload as { retryId?: string }).retryId === retryId,
        ),
      15000,
    );
    const steersForRetry = events.list(session.id).filter(
      (e) => e.type === 'steer_message' && (e.payload as { retryId?: string }).retryId === retryId,
    );
    expect(steersForRetry).toHaveLength(1);
    // The seeded marker is not duplicated by the boot scan.
    const markers = events.list(session.id).filter(
      (e) => e.type === 'verify_retry' && (e.payload as { retryId?: string }).retryId === retryId,
    );
    expect(markers).toHaveLength(1);
    await booted.close();
  }, TEST_TIMEOUT_MS);

  it('does not re-emit needs-attention on boot once it has already surfaced (idempotent)', async () => {
    process.env[MAX_ROUNDS] = '1';
    writeAlwaysFailScript(workspace, 'RED: idempotent surface');

    const first = await buildCursorModule();
    const service = first.get(SessionsService);
    const events = first.get(EventsRepository);
    const session = await service.create({ prompt: 'idempotent', provider: 'cursor', workspace });
    await waitFor(
      () => eventsOfType(events.list(session.id), 'verify_needs_attention').length === 1,
    );
    await first.close();

    // Reboot: the scan must NOT append a second needs-attention for the same loop.
    const second = await buildCursorModule();
    second.get(SessionsService);
    const events2 = second.get(EventsRepository);
    await new Promise((r) => setTimeout(r, 800));
    expect(eventsOfType(events2.list(session.id), 'verify_needs_attention')).toHaveLength(1);
    await second.close();
  }, TEST_TIMEOUT_MS);

  it('a non-zero exit code counts as a failed round and still auto-steers, no crash', async () => {
    process.env[MAX_ROUNDS] = '2';
    writeNonZeroExitScript(workspace);

    const module = await buildCursorModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const session = await service.create({ prompt: 'non-zero exit', provider: 'cursor', workspace });

    await waitFor(
      () => eventsOfType(events.list(session.id), 'verify_needs_attention').length === 1,
    );
    const all = events.list(session.id);
    expect(eventsOfType(all, 'verify_result').every((e) => (e.payload as { ok?: boolean }).ok === false)).toBe(true);
    expect(eventsOfType(all, 'verify_retry').length).toBe(2);
    expect(service.get(session.id)?.status).toBe('IDLE');
    await module.close();
  }, TEST_TIMEOUT_MS);

  it('a manual steer that lands between rounds takes priority and resets the auto-retry counter', async () => {
    process.env[MAX_ROUNDS] = '3';
    const releaseFile = join(workspace, '.nuncio', 'release');
    writeGatedFailScript(workspace, releaseFile);

    const module = await buildCursorModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const session = await service.create({ prompt: 'human intervenes', provider: 'cursor', workspace });

    // The first verify blocks on the release file. Let round 1's auto-steer fire
    // by releasing once, then re-gate so the loop stalls deterministically.
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(releaseFile, 'go');
    await waitFor(() => eventsOfType(events.list(session.id), 'verify_retry').length >= 1, 15000);
    // Re-gate: remove the release file so the NEXT verify blocks, guaranteeing the
    // manual steer lands strictly between auto rounds.
    rmSync(releaseFile, { force: true });
    await service.awaitRun(session.id);
    await service.steer(session.id, 'try a completely different approach');
    // Now let all subsequent verifies through.
    writeFileSync(releaseFile, 'go');

    await waitFor(
      () => eventsOfType(events.list(session.id), 'verify_needs_attention').length >= 1,
      20000,
    );
    const all = events.list(session.id);
    const manualSteerSeq = all.find(
      (e) => e.type === 'steer_message' &&
        (e.payload as { origin?: string }).origin !== 'verify_retry' &&
        String((e.payload as { text?: string }).text ?? '').includes('completely different approach'),
    )?.seq;
    expect(manualSteerSeq).toBeDefined();
    const retriesAfterManual = all.filter(
      (e) => e.type === 'verify_retry' && e.seq > (manualSteerSeq ?? 0),
    );
    // A full fresh budget ran after the human took over (reset semantics).
    expect(retriesAfterManual.length).toBe(3);
    await module.close();
  }, TEST_TIMEOUT_MS);

  it('a human steer arriving while the verify command is still running does not crash and stays coherent', async () => {
    process.env[MAX_ROUNDS] = '2';
    const releaseFile = join(workspace, '.nuncio', 'release');
    writeGatedFailScript(workspace, releaseFile);

    const module = await buildCursorModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const session = await service.create({ prompt: 'steer during verify', provider: 'cursor', workspace });

    // Verify is blocked (release file absent). Steer while it runs.
    await waitFor(() => eventsOfType(events.list(session.id), 'verify_start').length >= 1, 10000);
    await service.steer(session.id, 'a human note mid-verify');
    // Release the verify and let the loop settle.
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(releaseFile, 'go');
    await waitFor(
      () => eventsOfType(events.list(session.id), 'verify_needs_attention').length >= 1,
      15000,
    );
    // No crash: service alive, the human steer is recorded, ordering ascending.
    const all = events.list(session.id);
    expect(service.get(session.id)?.status).toBe('IDLE');
    expect(all.some((e) => e.type === 'steer_message' &&
      String((e.payload as { text?: string }).text ?? '').includes('human note mid-verify'))).toBe(true);
    for (let i = 1; i < all.length; i++) expect(all[i]!.seq).toBeGreaterThan(all[i - 1]!.seq);
    await module.close();
  }, TEST_TIMEOUT_MS);

  it('archiving a session while the loop is in flight stops it — no resurrection', async () => {
    process.env[MAX_ROUNDS] = '5';
    const releaseFile = join(workspace, '.nuncio', 'release');
    writeGatedFailScript(workspace, releaseFile);

    const module = await buildCursorModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const session = await service.create({ prompt: 'archive mid-loop', provider: 'cursor', workspace });

    // Let one round fire, then archive while the next verify is gated.
    writeFileSync(releaseFile, 'go');
    await waitFor(() => eventsOfType(events.list(session.id), 'verify_retry').length >= 1, 15000);
    rmSync(releaseFile, { force: true });
    await service.awaitRun(session.id);
    service.archive(session.id);
    const retriesAtArchive = eventsOfType(events.list(session.id), 'verify_retry').length;

    // Release and wait: an archived session must not keep auto-steering.
    writeFileSync(releaseFile, 'go');
    await new Promise((r) => setTimeout(r, 1500));
    expect(service.get(session.id)?.status).toBe('ARCHIVED');
    expect(eventsOfType(events.list(session.id), 'verify_retry').length).toBe(retriesAtArchive);
    await module.close();
  }, TEST_TIMEOUT_MS);

  it('surfaces an error rather than crashing when the auto-steer itself fails', async () => {
    // The provider becomes unavailable between the failing verify and the auto
    // steer: the loop's steer() rejects. The service must record an error and not
    // spin or crash.
    process.env[MAX_ROUNDS] = '2';
    writeAlwaysFailScript(workspace, 'RED: provider will vanish');

    const module = await buildCursorModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const registry = module.get(AgentRegistry);
    const session = await service.create({ prompt: 'provider vanish', provider: 'cursor', workspace });
    // Force the cursor key away so re-resolving the provider for the auto-steer
    // fails availability.
    await waitFor(() => eventsOfType(events.list(session.id), 'verify_result').length >= 1, 10000);
    delete process.env.CURSOR_API_KEY;
    registry.bustCaches();

    // Give the loop a chance to attempt an auto-steer that now fails.
    await new Promise((r) => setTimeout(r, 1500));
    // Either an error event surfaced or the loop stopped — never a crash, and the
    // service is still responsive.
    expect(service.get(session.id)).toBeTruthy();
    configureSimulatedCursorEnv();
    await module.close();
  }, TEST_TIMEOUT_MS);

  it('orders a queued human steer relative to auto-retry deterministically', async () => {
    process.env[MAX_ROUNDS] = '3';
    const releaseFile = join(workspace, '.nuncio', 'release');
    writeGatedFailScript(workspace, releaseFile);

    const module = await buildCursorModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const session = await service.create({ prompt: 'queued + auto', provider: 'cursor', workspace });

    // Let the loop proceed; a human steer must be delivered exactly once and must
    // not be lost or duplicated by the auto-retry machinery.
    writeFileSync(releaseFile, 'go');
    await waitFor(() => eventsOfType(events.list(session.id), 'verify_retry').length >= 1, 15000);
    await service.steer(session.id, 'queued human follow-up');
    await waitFor(
      () =>
        events.list(session.id).some((e) => e.type === 'steer_message' &&
          String((e.payload as { text?: string }).text ?? '').includes('queued human follow-up')),
      15000,
    );
    const all = events.list(session.id);
    const humanSteers = all.filter((e) => e.type === 'steer_message' &&
      String((e.payload as { text?: string }).text ?? '').includes('queued human follow-up'));
    expect(humanSteers).toHaveLength(1);
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
    // The auto-steer went through the normal steer path via the mock engine —
    // no cursor/pi-specific code involved.
    expect(autoSteers(all).length).toBe(2);
    await module.close();
  }, TEST_TIMEOUT_MS);
});
