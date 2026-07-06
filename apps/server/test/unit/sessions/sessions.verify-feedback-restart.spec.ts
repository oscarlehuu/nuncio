import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorAgentProvider } from '../../../src/agents/providers/cursor-agent.provider';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { ControllableAgentProvider } from '../../helpers/controllable-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SteerQueueRepository } from '../../../src/sessions/persistence/steer-queue.repository';
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

/**
 * Fails every run with a UNIQUE output per run (a counter is echoed), so the
 * futility guard (which trips on two byte-identical failures) never short-circuits
 * a budget/max-round test. Use this wherever a test asserts a specific retry count.
 */
function writeUniqueFailScript(workspace: string, label: string): void {
  mkdirSync(join(workspace, '.nuncio'), { recursive: true });
  const counterFile = join(workspace, '.nuncio', 'run-count');
  const script = [
    '#!/bin/sh',
    `COUNTER="${counterFile}"`,
    'N=$(cat "$COUNTER" 2>/dev/null || echo 0)',
    'N=$((N + 1))',
    'echo "$N" > "$COUNTER"',
    `echo "RED: ${label} #$N" >&2`,
    'exit 1',
  ].join('\n');
  writeFileSync(join(workspace, '.nuncio', 'verify'), `${script}\n`);
}

/** Non-zero EXIT (127) — an ordinary failed run, NOT a runVerifyCommand throw. */
function writeNonZeroExitScript(workspace: string): void {
  mkdirSync(join(workspace, '.nuncio'), { recursive: true });
  const counterFile = join(workspace, '.nuncio', 'run-count');
  const script = [
    '#!/bin/sh',
    `COUNTER="${counterFile}"`,
    'N=$(cat "$COUNTER" 2>/dev/null || echo 0)',
    'N=$((N + 1))',
    'echo "$N" > "$COUNTER"',
    // Distinct output per run so the futility guard never trips.
    'echo "RED exit127 #$N" >&2',
    'nonexistent-nuncio-binary 2>/dev/null || exit 127',
  ].join('\n');
  writeFileSync(join(workspace, '.nuncio', 'verify'), `${script}\n`);
}

/**
 * A verify script where EACH run blocks until its own numbered release marker
 * (`<releaseDir>/release-<N>`) appears — the Nth verify waits for `release-N`.
 * This gives airtight, per-round deterministic control (a later verify cannot
 * race ahead of an earlier release). Fails with UNIQUE output per run so a
 * futility guard never trips a budget test. `releaseAll` lets a test flip to
 * "let everything through" once the interesting boundary has passed.
 */
function writeGatedFailScript(workspace: string, releaseDir: string): void {
  mkdirSync(join(workspace, '.nuncio'), { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  const counterFile = join(workspace, '.nuncio', 'run-count');
  const script = [
    '#!/bin/sh',
    `COUNTER="${counterFile}"`,
    'N=$(cat "$COUNTER" 2>/dev/null || echo 0)',
    'N=$((N + 1))',
    'echo "$N" > "$COUNTER"',
    `while [ ! -f "${releaseDir}/release-$N" ] && [ ! -f "${releaseDir}/release-all" ]; do sleep 0.05; done`,
    'echo "RED: gated failure #$N" >&2',
    'exit 1',
  ].join('\n');
  writeFileSync(join(workspace, '.nuncio', 'verify'), `${script}\n`);
}

/** Release the Nth gated verify run. */
function releaseRound(releaseDir: string, n: number): void {
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, `release-${n}`), 'go');
}

/** Let every remaining gated verify run through. */
function releaseAll(releaseDir: string): void {
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, 'release-all'), 'go');
}

/**
 * Directly seed a failing verify_result into the log (deterministic crash setup);
 * returns the appended verify_result event so tests can count only post-seed work.
 */
function seedFailingVerifyResult(
  events: EventsRepository,
  sessionId: string,
  output: string,
): SessionEvent {
  events.append(sessionId, 'verify_start', { command: '.nuncio/verify' });
  return events.append(sessionId, 'verify_result', {
    command: '.nuncio/verify',
    ok: false,
    exitCode: 1,
    durationMs: 5,
    outputTail: output,
    timedOut: false,
  });
}

function baseModuleBuilder() {
  return Test.createTestingModule({
    imports: [
      DatabaseModule,
      SettingsModule,
      SessionsPersistenceModule,
      AgentsModule,
      GitModule,
      CursorLocalModule,
    ],
    providers: [SessionsService],
  });
}

async function buildCursorModule(): Promise<TestingModule> {
  return withSimulatedCursorProvider(baseModuleBuilder()).compile();
}

/** Module whose `cursor` provider is the ControllableAgentProvider (call spy + failable). */
async function buildControllableModule(): Promise<TestingModule> {
  return baseModuleBuilder()
    .overrideProvider(CursorAgentProvider)
    .useClass(ControllableAgentProvider)
    .compile();
}

async function waitFor(check: () => boolean, timeoutMs = 12000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within timeout');
    await new Promise((r) => setTimeout(r, 40));
  }
}

/**
 * Wait until the loop is provably PARKED just before round `nextRound`'s verify:
 * `round` auto-steers have fired AND `nextRound` verify_start events exist (the
 * next verify has begun and — with a gated script — is blocked on its release
 * marker). Only then is it safe to inject a manual steer / archive "between
 * rounds" without racing the loop (finding #3).
 */
async function waitForParkedBeforeRound(
  events: EventsRepository,
  sessionId: string,
  nextRound: number,
  timeoutMs = 15000,
): Promise<void> {
  const priorRounds = nextRound - 1;
  await waitFor(() => {
    const all = events.list(sessionId);
    const steers = all.filter(
      (e) => e.type === 'steer_message' &&
        (e.payload as { origin?: string }).origin === 'verify_retry',
    ).length;
    const verifyStarts = all.filter((e) => e.type === 'verify_start').length;
    return steers >= priorRounds && verifyStarts >= nextRound;
  }, timeoutMs);
}

describe('verify-feedback loop: restart, priority, lifecycle, provider-agnostic', () => {
  let dataDir: string;
  let workspace: string;
  const prior: Record<string, string | undefined> = {};
  // Per-test dirs are cleaned only in afterAll — NEVER mid-run. These tests build
  // several modules and deliberately leave loops in flight at close (a restart /
  // race simulation); module.close() does not await an in-flight provider.run, so
  // deleting the SQLite file in afterEach crashes that lingering write with a
  // SQLITE_IOERR ("disk I/O error") that Bun attributes to the NEXT test. Keeping
  // each test's DB on its own path (isolation) and deferring deletion removes both
  // the I/O crash and any cross-test event contamination.
  const dirsToClean: string[] = [];

  beforeAll(() => {
    configureSimulatedCursorEnv();
  });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-verify-feedback-restart-'));
    dirsToClean.push(dataDir);
    process.env.NUNCIO_DATA_DIR = dataDir;
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-vfr-ws-'));
    dirsToClean.push(workspace);
    prior[AUTO_STEER] = process.env[AUTO_STEER];
    prior[MAX_ROUNDS] = process.env[MAX_ROUNDS];
    prior.NUNCIO_FORCE_MOCK = process.env.NUNCIO_FORCE_MOCK;
    process.env[AUTO_STEER] = '1';
    process.env[MAX_ROUNDS] = '3';
  });

  afterEach(() => {
    delete process.env.NUNCIO_DATA_DIR;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(() => {
    for (const dir of dirsToClean) rmSync(dir, { recursive: true, force: true });
    delete process.env.CURSOR_API_KEY;
  });

  it('rebuilds the retry-round count from the event log after a restart', async () => {
    process.env[MAX_ROUNDS] = '6';
    writeUniqueFailScript(workspace, 'restart mid-retry');

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
    // Crash point (deterministic): a failing verify_result is the tail of the log,
    // with NO verify_retry after it. The loop is DISABLED during seed so no live
    // loop runs; we seed the failure by hand, then boot with the loop enabled so
    // only the boot scan can produce the retry (findings #2, #3).
    process.env[MAX_ROUNDS] = '2';
    process.env[AUTO_STEER] = '0';
    // A verify script is present at boot so the RESUMED loop can run its rounds,
    // but it never auto-steered before the crash (loop disabled + hand-seeded).
    writeUniqueFailScript(workspace, 'resumed after crash');

    const seed = await buildCursorModule();
    const seedSessions = seed.get(SessionsService);
    const seedEvents = seed.get(EventsRepository);
    const session = await seedSessions.create({
      prompt: 'crashed before retry',
      provider: 'cursor',
      workspace,
    });
    await seedSessions.awaitRun(session.id);
    // Seed a "failed verify, no retry" tail and record its seq. Only events after
    // this seed count as boot-scan work — so a no-boot-scan impl can't pass on
    // pre-seed events (finding #1).
    const seeded = seedFailingVerifyResult(seedEvents, session.id, 'RED: seeded pre-crash failure');
    await seed.close();

    // Boot with the loop ENABLED: the scan must resume the seeded failed verify.
    process.env[AUTO_STEER] = '1';
    const booted = await buildCursorModule();
    booted.get(SessionsService);
    const events = booted.get(EventsRepository);
    await waitFor(
      () =>
        events
          .list(session.id)
          .some((e) => e.type === 'verify_retry' && e.seq > seeded.seq),
      15000,
    );
    // The retry (and its auto-steer) landed strictly AFTER the seeded crash point.
    const all = events.list(session.id);
    const retry = all.find((e) => e.type === 'verify_retry' && e.seq > seeded.seq);
    expect(retry).toBeDefined();
    const steerAfterRetry = all.find(
      (e) => e.type === 'steer_message' &&
        (e.payload as { origin?: string }).origin === 'verify_retry' &&
        e.seq > retry!.seq,
    );
    expect(steerAfterRetry).toBeDefined();
    await booted.close();
  }, TEST_TIMEOUT_MS);

  it('shuts down within a bounded time while a boot-resumed retry hangs in the provider', async () => {
    // Seed a failed-verify tail (loop disabled), then boot with a provider whose
    // turn hangs (a stand-in for a real Cursor/Pi stream that ignores shutdown).
    // The boot scan resumes the loop and fires an auto-steer that never returns.
    // Closing the module MUST return within a bounded time — a hung provider must
    // never hold the daemon's shutdown hostage (finding #1) — and the resume chain
    // must be tracked so the bounded drain covers it (finding #2).
    process.env[MAX_ROUNDS] = '3';
    process.env[AUTO_STEER] = '0';

    const seed = await buildControllableModule();
    const seedSessions = seed.get(SessionsService);
    const seedEvents = seed.get(EventsRepository);
    const session = await seedSessions.create({ prompt: 'shutdown mid-resume', provider: 'cursor', workspace });
    await seedSessions.awaitRun(session.id);
    seedFailingVerifyResult(seedEvents, session.id, 'RED: shutdown mid-resume');
    await seed.close();

    // A verify command must exist so the resume evaluates and auto-steers.
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), 'echo RED >&2\nexit 1\n');

    process.env[AUTO_STEER] = '1';
    const booted = await buildControllableModule();
    booted.get(SessionsService);
    const events = booted.get(EventsRepository);
    const provider = booted.get(CursorAgentProvider) as unknown as ControllableAgentProvider;
    // The auto-steer turn hangs effectively forever.
    provider.setTurnDelay(60000);

    // Wait for the resume to fire the auto-steer marker (loop genuinely in flight,
    // the provider turn now hanging).
    await waitFor(
      () => eventsOfType(events.list(session.id), 'verify_retry').length >= 1,
      15000,
    );

    // Close while the provider turn hangs: must return bounded, not wait 60s.
    const start = Date.now();
    await booted.close();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(8000);
  }, TEST_TIMEOUT_MS);

  it('re-sends the dangling auto-steer after a restart between the retry marker and the steer', async () => {
    // Crash point (deterministic): verify_retry (with a retryId) is the tail of the
    // log, with NO steer_message after it. Boot must re-send exactly that steer
    // (idempotent on retryId), never a second retry marker. Fully seeded — no live
    // loop runs during setup, so the crash lands exactly here (findings #2, #3).
    process.env[MAX_ROUNDS] = '3';
    process.env[AUTO_STEER] = '0';
    writeUniqueFailScript(workspace, 'dangling retry');

    const seed = await buildCursorModule();
    const seedSessions = seed.get(SessionsService);
    const seedEvents = seed.get(EventsRepository);
    const session = await seedSessions.create({
      prompt: 'dangling retry',
      provider: 'cursor',
      workspace,
    });
    await seedSessions.awaitRun(session.id);
    // Seed a failed verify then a verify_retry marker with a known retryId and NO
    // following steer — the exact "marker written, steer not sent" crash point.
    seedFailingVerifyResult(seedEvents, session.id, 'RED: dangling retry');
    const retryId = 'danglingretry1';
    seedEvents.append(session.id, 'verify_retry', {
      round: 1,
      reason: 'verify_failed',
      command: '.nuncio/verify',
      outputTail: 'RED: dangling retry',
      retryId,
    });
    await seed.close();

    process.env[AUTO_STEER] = '1';
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

  it('on boot a persisted queued human steer wins over verify resume (no verify_retry precedes it)', async () => {
    // Both boot tasks fire on independent timers: the steer-queue drain and the
    // verify-loop resume. With a failed-verify tail AND a durable queued human
    // steer, the resume must DEFER to the pending queue — no verify_retry may
    // precede the human steer_message (finding #3). The human steer's turn is
    // slowed (availability delay) so, absent the fix, the resume interleaves and
    // emits a verify_retry before the drained steer lands.
    process.env[MAX_ROUNDS] = '3';
    process.env[AUTO_STEER] = '0';
    // No verify script at boot is needed — resume folds the SEEDED failed verify.

    const seed = await buildControllableModule();
    const seedSessions = seed.get(SessionsService);
    const seedEvents = seed.get(EventsRepository);
    const seedQueue = seed.get(SteerQueueRepository);
    const session = await seedSessions.create({
      prompt: 'boot precedence',
      provider: 'cursor',
      workspace,
    });
    await seedSessions.awaitRun(session.id);
    // Tail = a failing verify (loop-resume candidate) AND a durable queued steer.
    seedFailingVerifyResult(seedEvents, session.id, 'RED: boot precedence');
    seedQueue.enqueue(session.id, 'human queued across restart');
    await seed.close();

    process.env[AUTO_STEER] = '1';
    // A verify script so the resumed loop COULD auto-steer (and its verify passes
    // after the human turn, so the loop settles cleanly).
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), 'exit 0\n');

    const booted = await buildControllableModule();
    booted.get(SessionsService);
    const events = booted.get(EventsRepository);
    const provider = booted.get(CursorAgentProvider) as unknown as ControllableAgentProvider;
    provider.setAvailabilityDelay(80); // slow the human turn so resume can interleave

    await waitFor(
      () =>
        events.list(session.id).some((e) => e.type === 'steer_message' &&
          String((e.payload as { text?: string }).text ?? '').includes('human queued across restart')),
      15000,
    );
    const all = events.list(session.id);
    const humanSteerSeq = all.find((e) => e.type === 'steer_message' &&
      String((e.payload as { text?: string }).text ?? '').includes('human queued across restart'))!.seq;
    // No auto-retry marker precedes the human steer — the resume deferred.
    const retriesBeforeHuman = all.filter(
      (e) => e.type === 'verify_retry' && e.seq < humanSteerSeq,
    );
    expect(retriesBeforeHuman).toHaveLength(0);
    await booted.close();
  }, TEST_TIMEOUT_MS);

  it('does not re-emit needs-attention on boot once it has already surfaced (idempotent)', async () => {
    // Deterministic seed: a session whose durable tail is already a
    // verify_needs_attention (the loop surfaced and stopped before the crash). No
    // live loop runs during setup, so the state is unambiguous and load-immune.
    process.env[MAX_ROUNDS] = '1';
    process.env[AUTO_STEER] = '0';

    const seed = await buildCursorModule();
    const seedSessions = seed.get(SessionsService);
    const seedEvents = seed.get(EventsRepository);
    const session = await seedSessions.create({ prompt: 'idempotent', provider: 'cursor', workspace });
    await seedSessions.awaitRun(session.id);
    seedFailingVerifyResult(seedEvents, session.id, 'RED: already surfaced');
    seedEvents.append(session.id, 'verify_retry', {
      round: 1,
      reason: 'verify_failed',
      command: '.nuncio/verify',
      outputTail: 'RED: already surfaced',
      retryId: 'surfaced-retry-1',
    });
    // Its matching steer (so there is no dangling retry to resume), then the
    // surfaced needs-attention that stops the loop.
    seedEvents.append(session.id, 'steer_message', {
      text: 'fix it',
      origin: 'verify_retry',
      retryId: 'surfaced-retry-1',
    });
    seedEvents.append(session.id, 'verify_needs_attention', {
      rounds: 1,
      reason: 'max_rounds',
      lastOutputTail: 'RED: already surfaced',
    });
    expect(eventsOfType(seedEvents.list(session.id), 'verify_needs_attention')).toHaveLength(1);
    await seed.close();

    // Reboot with the loop ENABLED: the scan must NOT append a second
    // needs-attention (the tail is already a surfaced boundary — idempotent).
    process.env[AUTO_STEER] = '1';
    const booted = await buildCursorModule();
    booted.get(SessionsService);
    const events2 = booted.get(EventsRepository);
    await new Promise((r) => setTimeout(r, 800));
    expect(eventsOfType(events2.list(session.id), 'verify_needs_attention')).toHaveLength(1);
    await booted.close();
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
    const releaseDir = join(workspace, '.nuncio', 'releases');
    writeGatedFailScript(workspace, releaseDir);

    const module = await buildCursorModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const session = await service.create({ prompt: 'human intervenes', provider: 'cursor', workspace });

    // Release ONLY the first verify. Round 1 fails -> auto-steer fires -> the
    // SECOND verify begins and blocks on release-2 (never written). Wait until the
    // loop is provably parked there (auto-steer done + round-2 verify_start) so the
    // manual steer lands strictly between rounds.
    releaseRound(releaseDir, 1);
    await waitForParkedBeforeRound(events, session.id, 2);
    await service.steer(session.id, 'try a completely different approach');
    // Now let everything through so the fresh budget runs to exhaustion.
    releaseAll(releaseDir);

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
    // A full fresh budget of 3 ran after the human took over (reset semantics).
    expect(retriesAfterManual.length).toBe(3);
    await module.close();
  }, TEST_TIMEOUT_MS);

  it('a human steer arriving while the verify command is still running does not crash and stays coherent', async () => {
    process.env[MAX_ROUNDS] = '2';
    const releaseDir = join(workspace, '.nuncio', 'releases');
    writeGatedFailScript(workspace, releaseDir);

    const module = await buildCursorModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const session = await service.create({ prompt: 'steer during verify', provider: 'cursor', workspace });

    // Verify_start has fired and the script is blocked on release-1. Steer now,
    // while verify is provably still running.
    await waitFor(() => eventsOfType(events.list(session.id), 'verify_start').length >= 1, 10000);
    await service.steer(session.id, 'a human note mid-verify');
    // Release everything and let the loop settle.
    releaseAll(releaseDir);
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
    const releaseDir = join(workspace, '.nuncio', 'releases');
    writeGatedFailScript(workspace, releaseDir);

    const module = await buildCursorModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const session = await service.create({ prompt: 'archive mid-loop', provider: 'cursor', workspace });

    // Release only round 1; wait until the loop is provably parked before round 2's
    // verify (blocked on release-2, never written), then archive.
    releaseRound(releaseDir, 1);
    await waitForParkedBeforeRound(events, session.id, 2);
    service.archive(session.id);
    const retriesAtArchive = eventsOfType(events.list(session.id), 'verify_retry').length;

    // Let everything through: an archived session must not keep auto-steering.
    releaseAll(releaseDir);
    await new Promise((r) => setTimeout(r, 1500));
    expect(service.get(session.id)?.status).toBe('ARCHIVED');
    expect(eventsOfType(events.list(session.id), 'verify_retry').length).toBe(retriesAtArchive);
    await module.close();
  }, TEST_TIMEOUT_MS);

  it('surfaces an error VISIBLY rather than crashing when the auto-steer provider rejects', async () => {
    // The auto-steer turn genuinely rejects. Arm the failure BEFORE any steer can
    // run (steer-only arm), so the FIRST auto-steer is the one that fails — no race
    // (finding #2). The loop must settle visibly: an error event appears (the
    // rejection is surfaced, not swallowed), and the service stays responsive.
    process.env[MAX_ROUNDS] = '2';
    writeUniqueFailScript(workspace, 'provider will fail');

    const module = await buildControllableModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const provider = module.get(CursorAgentProvider) as unknown as ControllableAgentProvider;
    // Arm the steer-failure up front — the initial run() is not a steer, so it
    // succeeds; the first auto-steer() rejects.
    provider.failNextSteer(1);
    const session = await service.create({ prompt: 'provider fails', provider: 'cursor', workspace });

    // The rejection must surface as an observable error event (BaseAgentProvider
    // maps a non-cancel executePrompt throw to a status:ERROR + error event).
    await waitFor(
      () => eventsOfType(events.list(session.id), 'error').length >= 1,
      15000,
    );
    // The provider was actually driven for the auto-steer (a steer turn ran).
    expect(provider.steerRuns).toBeGreaterThanOrEqual(1);
    // No crash: the service is still responsive.
    expect(service.get(session.id)).toBeTruthy();
    await module.close();
  }, TEST_TIMEOUT_MS);

  it('a human steer racing the auto-steer window does not produce two interleaved turns', async () => {
    // The race: driveVerifyFeedback appends verify_retry, then awaits provider
    // availability while the session is still IDLE — a human steer entering there
    // could start a concurrent turn. We widen that window with an availability
    // delay and fire the human steer the instant the marker appears; the provider
    // must never see two overlapping turns (finding #2).
    process.env[MAX_ROUNDS] = '3';
    writeUniqueFailScript(workspace, 'race window');

    const module = await buildControllableModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const provider = module.get(CursorAgentProvider) as unknown as ControllableAgentProvider;
    // Slow every provider turn a little so the auto-steer's RUNNING claim is
    // genuinely in flight when the human steer arrives — the race, not a delay on
    // a code path autoSteer no longer takes (autoSteer resolves the provider
    // synchronously, so an isAvailable delay would never widen its window).
    provider.setTurnDelay(60);
    const session = await service.create({ prompt: 'race', provider: 'cursor', workspace });

    // The instant the first verify_retry marker lands, the auto-steer has claimed
    // the session — fire a human steer into that window; it must queue, not race a
    // second concurrent turn.
    await waitFor(() => eventsOfType(events.list(session.id), 'verify_retry').length >= 1, 15000);
    await service.steer(session.id, 'human races the auto-steer');

    const humanText = 'human races the auto-steer';
    const humanSteerMessages = () =>
      events.list(session.id).filter(
        (e) => e.type === 'steer_message' &&
          String((e.payload as { text?: string }).text ?? '').includes(humanText),
      );

    // Wait for the loop to settle AND the queued human steer to be delivered — the
    // steer is queued while RUNNING and drained to a steer_message on the next
    // IDLE, which under load lands after verify_needs_attention. Waiting on the
    // drained steer (not just needs_attention) is what makes this deterministic
    // under arbitrary machine load.
    await waitFor(
      () =>
        eventsOfType(events.list(session.id), 'verify_needs_attention').length >= 1 &&
        humanSteerMessages().length >= 1,
      20000,
    );
    // No two turns ever overlapped for this provider (serialized, not raced).
    expect(provider.sawOverlap).toBe(false);
    // The human steer was recorded exactly once (queued, then delivered).
    expect(humanSteerMessages()).toHaveLength(1);
    await module.close();
  }, TEST_TIMEOUT_MS);

  it('orders a queued human steer relative to auto-retry deterministically', async () => {
    process.env[MAX_ROUNDS] = '3';
    const releaseDir = join(workspace, '.nuncio', 'releases');
    writeGatedFailScript(workspace, releaseDir);

    const module = await buildCursorModule();
    const service = module.get(SessionsService);
    const events = module.get(EventsRepository);
    const session = await service.create({ prompt: 'queued + auto', provider: 'cursor', workspace });

    // Release round 1, then steer. The human steer must be delivered exactly once
    // and must not be lost or duplicated by the auto-retry machinery.
    releaseRound(releaseDir, 1);
    await waitForParkedBeforeRound(events, session.id, 2);
    await service.steer(session.id, 'queued human follow-up');
    releaseAll(releaseDir);
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
    writeUniqueFailScript(workspace, 'mock provider path');

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
    // The provider ACTUALLY RAN after each auto-steer: a mock assistant_message
    // follows each origin-tagged steer_message (finding #5 — not just a logged
    // marker; the engine produced output).
    for (const steer of autoSteers(all)) {
      const after = all.filter((e) => e.seq > steer.seq && e.type === 'assistant_message');
      expect(after.length).toBeGreaterThan(0);
    }
    await module.close();
  }, TEST_TIMEOUT_MS);
});
