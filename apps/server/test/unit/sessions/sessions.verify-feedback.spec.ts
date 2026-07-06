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
 * needs-attention signal. These specs are RED until that engine exists: they
 * assert on the auto-steer marker (`verify_retry`) and the needs-attention
 * event (`verify_needs_attention`), neither of which today's gate emits.
 */

const AUTO_STEER = 'NUNCIO_VERIFY_AUTO_STEER';
const MAX_ROUNDS = 'NUNCIO_VERIFY_MAX_ROUNDS';

function eventsOfType(events: SessionEvent[], type: string): SessionEvent[] {
  return events.filter((e) => e.type === type);
}

describe('SessionsService verify-feedback loop', () => {
  let module: TestingModule;
  let service: SessionsService;
  let events: EventsRepository;
  let dataDir: string;
  let workspace: string;

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
    // Loop enabled by default for these behavioural specs; the disabled case
    // sets it explicitly.
    process.env[AUTO_STEER] = '1';
    process.env[MAX_ROUNDS] = '3';
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    delete process.env[AUTO_STEER];
    delete process.env[MAX_ROUNDS];
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  /**
   * Write a `.nuncio/verify` script that fails the first `failTimes` runs and
   * passes afterwards. State is kept in a counter file in the workspace so the
   * script sees each successive turn.
   */
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

  // Once the loop is implemented it settles in a couple of seconds; the wait is
  // generous so a real settle is never cut off, but the third arg to each `it`
  // gives the harness enough headroom that an unsettled loop fails on an
  // assertion (feature missing) rather than a bare harness timeout.
  const TEST_TIMEOUT_MS = 20000;

  async function waitForSettled(sessionId: string, timeoutMs = 8000): Promise<SessionEvent[]> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const all = events.list(sessionId);
      const done =
        eventsOfType(all, 'verify_needs_attention').length > 0 ||
        all.some((e) => e.type === 'verify_result' && (e.payload as { ok?: boolean }).ok === true);
      // Also give a beat after the terminal event so no trailing round sneaks in.
      if (done) {
        await new Promise((r) => setTimeout(r, 200));
        return events.list(sessionId);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return events.list(sessionId);
  }

  it('a passing verify triggers no auto-steer and no needs-attention', async () => {
    writeFlakyVerifyScript(0); // passes immediately
    const session = await service.create({ prompt: 'green task', provider: 'cursor', workspace });

    const all = await waitForSettled(session.id);
    expect(eventsOfType(all, 'verify_retry')).toHaveLength(0);
    expect(eventsOfType(all, 'verify_needs_attention')).toHaveLength(0);
    // Exactly one verify_result, and it passed.
    const results = eventsOfType(all, 'verify_result');
    expect(results).toHaveLength(1);
    expect(results[0]!.payload).toMatchObject({ ok: true });
  }, TEST_TIMEOUT_MS);

  it('a failing verify auto-steers with the failure output, then a fix ends the loop and resets', async () => {
    writeFlakyVerifyScript(1, 'RED: expected 2 got 1'); // fails once, then passes
    const session = await service.create({ prompt: 'fixable task', provider: 'cursor', workspace });

    const all = await waitForSettled(session.id);

    // One retry round fired, carrying the failure output.
    const retries = eventsOfType(all, 'verify_retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]!.payload).toMatchObject({ round: 1 });
    expect(String((retries[0]!.payload as { outputTail?: string }).outputTail ?? '')).toContain(
      'RED: expected 2 got 1',
    );

    // The auto-steer produced a real steer_message the agent acted on.
    expect(eventsOfType(all, 'steer_message').length).toBeGreaterThanOrEqual(1);

    // Ended green, no needs-attention.
    const results = eventsOfType(all, 'verify_result');
    expect(results.at(-1)!.payload).toMatchObject({ ok: true });
    expect(eventsOfType(all, 'verify_needs_attention')).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it('fails all N rounds then stops with needs-attention, never round N+1', async () => {
    process.env[MAX_ROUNDS] = '3';
    writeAlwaysFailScript('RED: permanently broken');
    const session = await service.create({ prompt: 'unfixable task', provider: 'cursor', workspace });

    const all = await waitForSettled(session.id);

    // Exactly N=3 retry rounds — not a fourth.
    expect(eventsOfType(all, 'verify_retry')).toHaveLength(3);
    const needs = eventsOfType(all, 'verify_needs_attention');
    expect(needs).toHaveLength(1);
    expect(needs[0]!.payload).toMatchObject({ reason: 'max_rounds', rounds: 3 });
    // Session never wedged — FSM untouched (annotate, don't block).
    expect(service.get(session.id)?.status).toBe('IDLE');
  }, TEST_TIMEOUT_MS);

  it('identical failure output two rounds running stops early (futility guard)', async () => {
    process.env[MAX_ROUNDS] = '5';
    writeAlwaysFailScript('RED: identical every time');
    const session = await service.create({ prompt: 'stuck task', provider: 'cursor', workspace });

    const all = await waitForSettled(session.id);

    // The guard must trip well before the 5-round budget is exhausted.
    expect(eventsOfType(all, 'verify_retry').length).toBeLessThan(5);
    const needs = eventsOfType(all, 'verify_needs_attention');
    expect(needs).toHaveLength(1);
    expect(needs[0]!.payload).toMatchObject({ reason: 'repeated_failure' });
  }, TEST_TIMEOUT_MS);

  it('behaves exactly as today when the loop is disabled', async () => {
    process.env[AUTO_STEER] = '0';
    writeAlwaysFailScript('RED: disabled path');
    const session = await service.create({ prompt: 'disabled task', provider: 'cursor', workspace });

    // A verify_result should land; nothing beyond it.
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (events.list(session.id).some((e) => e.type === 'verify_result')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 300));
    const all = events.list(session.id);
    expect(eventsOfType(all, 'verify_result')).toHaveLength(1);
    expect(eventsOfType(all, 'verify_retry')).toHaveLength(0);
    expect(eventsOfType(all, 'verify_needs_attention')).toHaveLength(0);
  });

  it('a client replaying by seq cursor sees a coherent fail -> retry -> steer -> new turn sequence', async () => {
    writeFlakyVerifyScript(1, 'RED: seq replay case');
    const session = await service.create({ prompt: 'replay task', provider: 'cursor', workspace });

    await waitForSettled(session.id);

    // Replay strictly by ascending seq, as a reconnecting client would.
    const ordered = events.list(session.id, 0);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]!.seq).toBeGreaterThan(ordered[i - 1]!.seq);
    }
    const firstFailIdx = ordered.findIndex(
      (e) => e.type === 'verify_result' && (e.payload as { ok?: boolean }).ok === false,
    );
    const retryIdx = ordered.findIndex((e) => e.type === 'verify_retry');
    const steerIdx = ordered.findIndex((e) => e.type === 'steer_message');
    expect(firstFailIdx).toBeGreaterThanOrEqual(0);
    // The retry marker follows the failure and precedes the steer it produced.
    expect(retryIdx).toBeGreaterThan(firstFailIdx);
    expect(steerIdx).toBeGreaterThan(retryIdx);
  }, TEST_TIMEOUT_MS);
});
