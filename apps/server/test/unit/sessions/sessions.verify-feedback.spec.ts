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
 * Rung 1 — the verify-feedback loop. A failing post-turn verify auto-steers the
 * same session with the failure output, up to N rounds, then surfaces a
 * needs-attention signal. RED until that engine exists.
 *
 * Auto-steers are distinguished from human steers by an EXPLICIT origin tag on
 * the steer_message payload (`origin: 'verify_retry'` + `retryId`), never by
 * event adjacency — the base provider emits `status: RUNNING` between any prior
 * marker and the steer_message, so adjacency would misclassify.
 */

const AUTO_STEER = 'NUNCIO_VERIFY_AUTO_STEER';
const MAX_ROUNDS = 'NUNCIO_VERIFY_MAX_ROUNDS';
const TEST_TIMEOUT_MS = 20000;

function eventsOfType(events: SessionEvent[], type: string): SessionEvent[] {
  return events.filter((e) => e.type === type);
}

function autoSteers(events: SessionEvent[]): SessionEvent[] {
  return events.filter(
    (e) => e.type === 'steer_message' &&
      (e.payload as { origin?: string }).origin === 'verify_retry',
  );
}

function restoreEnv(prior: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('SessionsService verify-feedback loop', () => {
  let module: TestingModule;
  let service: SessionsService;
  let events: EventsRepository;
  let dataDir: string;
  let workspace: string;
  const prior: Record<string, string | undefined> = {};

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-verify-feedback-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();

    module = await withSimulatedCursorProvider(
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

    service = module.get(SessionsService);
    events = module.get(EventsRepository);
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-verify-feedback-ws-'));
    // Preserve prior env so a shared shell is left untouched (review suggestion #1).
    prior[AUTO_STEER] = process.env[AUTO_STEER];
    prior[MAX_ROUNDS] = process.env[MAX_ROUNDS];
    process.env[AUTO_STEER] = '1';
    process.env[MAX_ROUNDS] = '3';
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    restoreEnv(prior);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  /** A `.nuncio/verify` script that fails `failTimes` runs then passes. */
  function writeFlakyVerifyScript(failTimes: number, failOutput = 'RED: assertion failed'): void {
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    const counterFile = join(workspace, '.nuncio', 'run-count');
    const script = [
      '#!/bin/sh',
      `COUNTER="${counterFile}"`,
      'N=$(cat "$COUNTER" 2>/dev/null || echo 0)',
      'N=$((N + 1))',
      'echo "$N" > "$COUNTER"',
      `if [ "$N" -le ${failTimes} ]; then`,
      `  echo "${failOutput}" >&2`,
      '  exit 1',
      'fi',
      'echo GREEN',
      'exit 0',
    ].join('\n');
    writeFileSync(join(workspace, '.nuncio', 'verify'), `${script}\n`);
  }

  function writeAlwaysFailScript(output = 'RED: still broken'): void {
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), `echo "${output}" >&2\nexit 1\n`);
  }

  /** Fails every run, but emits a UNIQUE output each time (defeats the futility guard). */
  function writeAlwaysFailUniqueScript(): void {
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    const counterFile = join(workspace, '.nuncio', 'run-count');
    const script = [
      '#!/bin/sh',
      `COUNTER="${counterFile}"`,
      'N=$(cat "$COUNTER" 2>/dev/null || echo 0)',
      'N=$((N + 1))',
      'echo "$N" > "$COUNTER"',
      'echo "RED: distinct failure $N" >&2',
      'exit 1',
    ].join('\n');
    writeFileSync(join(workspace, '.nuncio', 'verify'), `${script}\n`);
  }

  async function waitForSettled(sessionId: string, timeoutMs = 8000): Promise<SessionEvent[]> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const all = events.list(sessionId);
      const done =
        eventsOfType(all, 'verify_needs_attention').length > 0 ||
        all.some((e) => e.type === 'verify_result' && (e.payload as { ok?: boolean }).ok === true);
      if (done) {
        await new Promise((r) => setTimeout(r, 250));
        return events.list(sessionId);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return events.list(sessionId);
  }

  it('a passing verify triggers no auto-steer and no needs-attention', async () => {
    writeFlakyVerifyScript(0);
    const session = await service.create({ prompt: 'green task', provider: 'cursor', workspace });

    const all = await waitForSettled(session.id);
    expect(eventsOfType(all, 'verify_retry')).toHaveLength(0);
    expect(eventsOfType(all, 'verify_needs_attention')).toHaveLength(0);
    const results = eventsOfType(all, 'verify_result');
    expect(results).toHaveLength(1);
    expect(results[0]!.payload).toMatchObject({ ok: true });
  }, TEST_TIMEOUT_MS);

  it('the auto-steer carries the verify command and failure output in its text, tagged origin verify_retry', async () => {
    writeFlakyVerifyScript(1, 'RED-MARKER: expected 2 got 1');
    const session = await service.create({ prompt: 'fixable task', provider: 'cursor', workspace });

    const all = await waitForSettled(session.id);

    const retries = eventsOfType(all, 'verify_retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]!.payload).toMatchObject({
      round: 1,
      reason: 'verify_failed',
      command: '.nuncio/verify',
    });
    expect(String((retries[0]!.payload as { outputTail?: string }).outputTail ?? '')).toContain(
      'RED-MARKER: expected 2 got 1',
    );

    // The steer the loop produced is origin-tagged AND its TEXT carries the
    // command + failure output — a lazy "please retry" impl must fail here.
    const auto = autoSteers(all);
    expect(auto).toHaveLength(1);
    const steerText = String((auto[0]!.payload as { text?: string }).text ?? '');
    expect(steerText).toContain('.nuncio/verify');
    expect(steerText).toContain('RED-MARKER: expected 2 got 1');
    const retryId = (retries[0]!.payload as { retryId?: string }).retryId;
    expect(retryId).toBeTruthy();
    expect((auto[0]!.payload as { retryId?: string }).retryId).toBe(retryId);

    // The provider ACTUALLY RAN after the auto-steer: an assistant_message follows
    // the origin-tagged steer_message (finding #5 — not just a logged marker).
    const assistantAfter = all.filter(
      (e) => e.seq > auto[0]!.seq && e.type === 'assistant_message',
    );
    expect(assistantAfter.length).toBeGreaterThan(0);

    expect(eventsOfType(all, 'verify_result').at(-1)!.payload).toMatchObject({ ok: true });
    expect(eventsOfType(all, 'verify_needs_attention')).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it('classifies the auto-steer by explicit origin, not by the event that precedes it', async () => {
    writeFlakyVerifyScript(1, 'RED: origin case');
    const session = await service.create({ prompt: 'origin task', provider: 'cursor', workspace });

    const all = await waitForSettled(session.id);
    const auto = autoSteers(all);
    expect(auto).toHaveLength(1);
    const idx = all.findIndex((e) => e.seq === auto[0]!.seq);
    // The immediately-preceding event is a status:RUNNING, NOT the retry marker —
    // proving adjacency-based classification would be wrong.
    const prev = all[idx - 1]!;
    expect(prev.type).toBe('status');
    expect((prev.payload as { status?: string }).status).toBe('RUNNING');
  }, TEST_TIMEOUT_MS);

  it('fails all N rounds then stops with needs-attention, never round N+1', async () => {
    process.env[MAX_ROUNDS] = '3';
    writeAlwaysFailUniqueScript(); // distinct output each round so futility never trips first
    const session = await service.create({ prompt: 'unfixable task', provider: 'cursor', workspace });

    const all = await waitForSettled(session.id);

    expect(eventsOfType(all, 'verify_retry')).toHaveLength(3);
    const needs = eventsOfType(all, 'verify_needs_attention');
    expect(needs).toHaveLength(1);
    expect(needs[0]!.payload).toMatchObject({ reason: 'max_rounds', rounds: 3 });
    expect(typeof (needs[0]!.payload as { lastOutputTail?: string }).lastOutputTail).toBe('string');
    expect(service.get(session.id)?.status).toBe('IDLE');
  }, TEST_TIMEOUT_MS);

  it('stops at exactly two rounds when the failure output repeats (futility guard)', async () => {
    process.env[MAX_ROUNDS] = '5';
    writeAlwaysFailScript('RED: identical every time');
    const session = await service.create({ prompt: 'stuck task', provider: 'cursor', workspace });

    const all = await waitForSettled(session.id);

    // Needs >=2 failing results, and stops at EXACTLY 2 retries (never 1, never 5).
    expect(eventsOfType(all, 'verify_retry')).toHaveLength(2);
    const needs = eventsOfType(all, 'verify_needs_attention');
    expect(needs).toHaveLength(1);
    expect(needs[0]!.payload).toMatchObject({ reason: 'repeated_failure', rounds: 2 });
    expect(String((needs[0]!.payload as { lastOutputTail?: string }).lastOutputTail ?? '')).toContain(
      'RED: identical every time',
    );
  }, TEST_TIMEOUT_MS);

  it('surfaces needs-attention immediately with no auto-steer when max rounds is 0', async () => {
    process.env[MAX_ROUNDS] = '0';
    writeAlwaysFailScript('RED: zero budget');
    const session = await service.create({ prompt: 'zero task', provider: 'cursor', workspace });

    const all = await waitForSettled(session.id);
    expect(eventsOfType(all, 'verify_retry')).toHaveLength(0);
    const needs = eventsOfType(all, 'verify_needs_attention');
    expect(needs).toHaveLength(1);
    expect(needs[0]!.payload).toMatchObject({ rounds: 0 });
  }, TEST_TIMEOUT_MS);

  it('behaves exactly as today when the loop is disabled', async () => {
    process.env[AUTO_STEER] = '0';
    writeAlwaysFailScript('RED: disabled path');
    const session = await service.create({ prompt: 'disabled task', provider: 'cursor', workspace });

    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (events.list(session.id).some((e) => e.type === 'verify_result')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 400));
    const all = events.list(session.id);
    expect(eventsOfType(all, 'verify_result')).toHaveLength(1);
    expect(eventsOfType(all, 'verify_retry')).toHaveLength(0);
    expect(eventsOfType(all, 'verify_needs_attention')).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it('an empty verify output still produces a coherent auto-steer', async () => {
    // Fails with NO stdout/stderr the first run, then passes.
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    const counterFile = join(workspace, '.nuncio', 'run-count');
    writeFileSync(
      join(workspace, '.nuncio', 'verify'),
      [
        '#!/bin/sh',
        `N=$(cat "${counterFile}" 2>/dev/null || echo 0)`,
        'N=$((N + 1))',
        `echo "$N" > "${counterFile}"`,
        '[ "$N" -le 1 ] && exit 1',
        'exit 0',
        '',
      ].join('\n'),
    );
    const session = await service.create({ prompt: 'empty output task', provider: 'cursor', workspace });

    const all = await waitForSettled(session.id);
    const auto = autoSteers(all);
    expect(auto).toHaveLength(1);
    const text = String((auto[0]!.payload as { text?: string }).text ?? '').trim();
    // The steer text is non-empty and coherent even with no captured output.
    expect(text.length).toBeGreaterThan(10);
    expect(text.toLowerCase()).toContain('verify');
  }, TEST_TIMEOUT_MS);

  it('an oversized verify output is capped in the auto-steer text', async () => {
    // Emit far more than the 4000-char OUTPUT_TAIL cap on the first (failing) run.
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    const counterFile = join(workspace, '.nuncio', 'run-count');
    writeFileSync(
      join(workspace, '.nuncio', 'verify'),
      [
        '#!/bin/sh',
        `N=$(cat "${counterFile}" 2>/dev/null || echo 0)`,
        'N=$((N + 1))',
        `echo "$N" > "${counterFile}"`,
        'if [ "$N" -le 1 ]; then',
        // Leading marker (dropped by the tail) then a huge block then a trailing
        // marker (retained by the tail).
        '  echo "LEADING-MARKER-DROPPED" >&2',
        '  i=0; while [ "$i" -lt 20000 ]; do printf X; i=$((i+1)); done >&2',
        '  echo "" >&2; echo "TRAILING-MARKER-KEPT" >&2',
        '  exit 1',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    const session = await service.create({ prompt: 'big output task', provider: 'cursor', workspace });

    const all = await waitForSettled(session.id);
    const auto = autoSteers(all);
    expect(auto).toHaveLength(1);
    const text = String((auto[0]!.payload as { text?: string }).text ?? '');
    // The full 20k stream is never carried; the tail is capped near 4000 chars.
    const xRun = /X{100,}/.exec(text)?.[0].length ?? 0;
    expect(xRun).toBeLessThanOrEqual(4000);
    // The RETAINED tail (end of output) is present; the dropped leading marker is not.
    expect(text).toContain('TRAILING-MARKER-KEPT');
    expect(text).not.toContain('LEADING-MARKER-DROPPED');
  }, TEST_TIMEOUT_MS);

  it('a manual steer after needs-attention starts a fresh loop', async () => {
    process.env[MAX_ROUNDS] = '1';
    writeAlwaysFailScript('RED: keeps failing after surface');
    const session = await service.create({ prompt: 'post-surface steer', provider: 'cursor', workspace });

    // Wait for the first needs-attention.
    await waitForSettled(session.id);
    const firstNeeds = eventsOfType(events.list(session.id), 'verify_needs_attention')[0];
    expect(firstNeeds).toBeDefined();

    // Founder steers again; a new loop must run a fresh budget from a failure
    // that lands AFTER the needs-attention boundary.
    await service.awaitRun(session.id);
    await service.steer(session.id, 'please try yet another angle');
    await waitForSettled(session.id, 12000);

    const all = events.list(session.id);
    const retriesAfterSurface = all.filter(
      (e) => e.type === 'verify_retry' && e.seq > firstNeeds!.seq,
    );
    // A fresh budget of 1 retry ran after the manual steer.
    expect(retriesAfterSurface.length).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('a client replaying by seq cursor sees a coherent fail -> retry -> auto steer -> new turn sequence', async () => {
    writeFlakyVerifyScript(1, 'RED: seq replay case');
    const session = await service.create({ prompt: 'replay task', provider: 'cursor', workspace });

    await waitForSettled(session.id);

    const ordered = events.list(session.id, 0);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]!.seq).toBeGreaterThan(ordered[i - 1]!.seq);
    }
    const firstFailIdx = ordered.findIndex(
      (e) => e.type === 'verify_result' && (e.payload as { ok?: boolean }).ok === false,
    );
    const retryIdx = ordered.findIndex((e) => e.type === 'verify_retry');
    const steerIdx = ordered.findIndex(
      (e) => e.type === 'steer_message' &&
        (e.payload as { origin?: string }).origin === 'verify_retry',
    );
    expect(firstFailIdx).toBeGreaterThanOrEqual(0);
    expect(retryIdx).toBeGreaterThan(firstFailIdx);
    expect(steerIdx).toBeGreaterThan(retryIdx);
  }, TEST_TIMEOUT_MS);
});
