import { describe, expect, it } from 'bun:test';
import { byteLength } from '../../../src/orchestration/byte-truncate';
import {
  buildSessionStateSnapshot,
  type SnapshotEventLike,
} from '../../../src/sessions/domain/session-state-snapshot';

/**
 * The survivors snapshot: the pinned-state block a compaction must carry
 * verbatim (plan, latest verify, open reproduction gate, open chips), derived
 * deterministically from the durable event log. Provider-neutral by design —
 * the Pi compaction extension is the first consumer, any engine can reuse it.
 */

function planEvent(items: Array<{ id?: string; text: string; status?: string }>): SnapshotEventLike {
  return { type: 'plan_updated', payload: { items } };
}

function verifyEvent(overrides: Record<string, unknown> = {}): SnapshotEventLike {
  return {
    type: 'verify_result',
    payload: {
      command: 'bun run gate',
      ok: false,
      exitCode: 1,
      durationMs: 1200,
      outputTail: '3 tests failed in sessions.service.spec.ts',
      timedOut: false,
      ...overrides,
    },
  };
}

describe('buildSessionStateSnapshot', () => {
  it('returns an empty string when nothing needs pinning', () => {
    expect(buildSessionStateSnapshot([])).toBe('');
    expect(
      buildSessionStateSnapshot([
        { type: 'assistant_message', payload: { text: 'hello' } },
        { type: 'status', payload: { status: 'IDLE' } },
      ]),
    ).toBe('');
  });

  it('pins the latest plan verbatim with checkbox statuses', () => {
    const snapshot = buildSessionStateSnapshot([
      planEvent([{ text: 'old item', status: 'done' }]),
      planEvent([
        { text: 'write the failing spec', status: 'done' },
        { text: 'implement the module', status: 'in_progress' },
        { text: 'run the gate', status: 'pending' },
      ]),
    ]);
    expect(snapshot).toContain('## Pinned session state');
    expect(snapshot).toContain('- [x] write the failing spec');
    expect(snapshot).toContain('- [~] implement the module');
    expect(snapshot).toContain('- [ ] run the gate');
    expect(snapshot).not.toContain('old item');
  });

  it('pins the latest verify result with its command and failure tail', () => {
    const snapshot = buildSessionStateSnapshot([
      verifyEvent({ ok: true, exitCode: 0, outputTail: '' }),
      verifyEvent(),
    ]);
    expect(snapshot).toContain('Verify: FAILED (exit 1) — `bun run gate`');
    expect(snapshot).toContain('3 tests failed in sessions.service.spec.ts');
  });

  it('renders a green verify with its head pin when present', () => {
    const snapshot = buildSessionStateSnapshot([
      verifyEvent({ ok: true, exitCode: 0, outputTail: '', head: 'abc1234def' }),
    ]);
    expect(snapshot).toContain('Verify: green — `bun run gate` (head abc1234d)');
  });

  it('pins the latest reproduction request with its steps', () => {
    const snapshot = buildSessionStateSnapshot([
      {
        type: 'reproduce_requested',
        payload: { ref: 'repro-1', steps: ['open the composer', 'paste an image', 'press send'] },
      },
    ]);
    expect(snapshot).toContain('Reproduction gate repro-1:');
    expect(snapshot).toContain('1. open the composer');
    expect(snapshot).toContain('3. press send');
  });

  it('pins proposed chips and drops dismissed ones', () => {
    const snapshot = buildSessionStateSnapshot([
      {
        type: 'spawn_task_proposed',
        payload: { title: 'Fix relay retry', tldr: 'Dead branch in relay.ts', prompt: 'p1', ref: 'chip-1' },
      },
      {
        type: 'spawn_task_proposed',
        payload: { title: 'Add spec for FSM', tldr: 'Missing edge row', prompt: 'p2', ref: 'chip-2' },
      },
      { type: 'spawn_task_dismissed', payload: { id: 'chip-1', reason: 'obsolete' } },
    ]);
    expect(snapshot).toContain('Add spec for FSM');
    expect(snapshot).not.toContain('Fix relay retry');
  });

  it('is byte-identical for identical inputs', () => {
    const events = [
      planEvent([{ text: 'stable render', status: 'pending' }]),
      verifyEvent(),
    ];
    expect(buildSessionStateSnapshot(events)).toBe(buildSessionStateSnapshot(events));
  });

  it('holds the total budget by dropping the lowest-priority sections first', () => {
    const events: SnapshotEventLike[] = [
      planEvent([{ text: 'plan item that must survive', status: 'in_progress' }]),
      verifyEvent({ outputTail: 'x'.repeat(400) }),
      {
        type: 'reproduce_requested',
        payload: { ref: 'repro-1', steps: ['step '.repeat(30)] },
      },
      {
        type: 'spawn_task_proposed',
        payload: { title: 'chip title', tldr: 'y'.repeat(300), prompt: 'p', ref: 'chip-9' },
      },
    ];
    const full = buildSessionStateSnapshot(events);
    expect(full).toContain('chip title');

    const tight = buildSessionStateSnapshot(events, { totalBytes: 700 });
    expect(byteLength(tight)).toBeLessThanOrEqual(700);
    // Plan (highest priority) survives; chips (lowest) drop first.
    expect(tight).toContain('plan item that must survive');
    expect(tight).not.toContain('chip title');
  });

  it('never throws on malformed payloads', () => {
    const snapshot = buildSessionStateSnapshot([
      { type: 'plan_updated', payload: null },
      { type: 'plan_updated', payload: { items: 'not-an-array' } },
      { type: 'verify_result', payload: { ok: 'yes' } },
      { type: 'reproduce_requested', payload: { ref: 42 } },
      { type: 'spawn_task_proposed', payload: undefined },
      { type: 'spawn_task_dismissed', payload: {} },
    ]);
    expect(typeof snapshot).toBe('string');
  });
});
