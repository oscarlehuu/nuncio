import { describe, expect, it } from 'vitest';
import { CREW_PHASES, projectCrewRun } from './crew-run-projection';
import type { CrewEventDto, CrewRunDetailDto, CrewRunPhase, CrewRunStatus } from './crew-api';

const headA = 'a'.repeat(40);
const headB = 'b'.repeat(40);
const snapshot = {
  presetId: 'quality' as const,
  sourceProfileId: 'p1',
  sourceProfileRevision: 1,
  bindings: {
    foreman: { provider: 'claude', model: 'fable' },
    builder: { provider: 'codex', model: 'sol' },
    reviewer: { provider: 'claude', model: 'opus' },
  },
  tester: { kind: 'nuncio' as const, runtimePolicy: 'read-only' as const },
  policy: { verifyCommand: 'bun test', maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true },
  resolvedAt: 1,
};
const base = (phase: CrewRunPhase = 'BUILD', status: CrewRunStatus = 'RUNNING'): CrewRunDetailDto => ({
  id: 'r1', taskId: 't1', priorRunId: null, phase, status, outcome: null, blockedReason: null,
  profileSnapshot: snapshot, context: {}, contextRevision: 1, revision: 1, projectPath: '/repo', baseBranch: 'main',
  worktreePath: '/work', branch: 'crew', workspaceHead: headA, verifyRetriesUsed: 1, reviewRetriesUsed: 0,
  maxVerifyRetries: 2, maxReviewRetries: 2, verifyExtraRounds: 0, reviewExtraRounds: 0,
  members: [], gates: [], results: [], artifacts: [], createdAt: 1, updatedAt: 1,
});
const event = (seq: number, type: string, payload: Record<string, unknown>): CrewEventDto => ({
  runId: 'r1', seq, type, payload, idempotencyKey: `k${seq}`, actor: 'system', contextRevision: 1,
  workspaceHead: headA, createdAt: seq,
});

describe('projectCrewRun', () => {
  it.each([
    ['PLAN', 'QUEUED'], ['BUILD', 'RUNNING'], ['VERIFY', 'BLOCKED_USER'], ['REVIEW', 'BLOCKED_PROVIDER'],
    ['SYNTHESIZE', 'RECOVERING'], ['BUILD', 'PAUSED'],
  ] as Array<[CrewRunPhase, CrewRunStatus]>)('keeps the phase/status tuple visible for %s · %s', (phase, status) => {
    const projection = projectCrewRun(base(phase, status));
    expect(projection.summary).toContain(phase[0] + phase.slice(1).toLowerCase());
    const statusLabel = status.toLowerCase().replace('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
    expect(projection.summary).toContain(statusLabel);
    expect(projection.run.phase).toBe(phase);
  });

  it('marks the fixed ordered current step with prior steps complete', () => {
    const projection = projectCrewRun(base('VERIFY'));
    expect(projection.steps.map((step) => step.phase)).toEqual(CREW_PHASES);
    expect(projection.steps.find((step) => step.phase === 'VERIFY')?.state).toBe('current');
    expect(projection.steps.find((step) => step.phase === 'BUILD')?.state).toBe('complete');
  });

  it('RECOVERING and BLOCKED_PROVIDER preserve the active phase', () => {
    const projected = projectCrewRun(base('BUILD'), [
      event(2, 'recovery_started', {}),
      event(3, 'provider_blocked', { reason: 'provider_unavailable' }),
    ]);
    expect(projected.run).toMatchObject({ phase: 'BUILD', status: 'BLOCKED_PROVIDER', blockedReason: 'provider_unavailable' });
  });

  it('projects a recovery block without waiting for a full run refetch', () => {
    const projected = projectCrewRun(base('BUILD', 'RECOVERING'), [
      event(2, 'recovery_blocked', { reason: 'workspace moved' }),
    ]);

    expect(projected.run).toMatchObject({
      phase: 'BUILD', status: 'BLOCKED_USER', blockedReason: 'unrecoverable_failure', revision: 2,
    });
  });

  it('keeps the strict fresh-final-review handoff inside REVIEW', () => {
    const projected = projectCrewRun(base('REVIEW', 'RUNNING'), [
      { ...event(2, 'final_review_requested', { basedOnWorkspaceHead: headA }), contextRevision: 2 },
      { ...event(3, 'final_reviewer_claimed', { basedOnWorkspaceHead: headA }), contextRevision: 3 },
    ]);

    expect(projected.run).toMatchObject({ phase: 'REVIEW', status: 'RUNNING' });
    expect(projected.run.contextRevision).toBe(3);
    expect(projected.steps.find((step) => step.phase === 'REVIEW')?.state).toBe('current');
  });

  it('workspace advance makes old-head gate evidence stale', () => {
    const run = base('REVIEW');
    run.gates = [
      { kind: 'verify', status: 'passed', workspaceHead: headA, warnings: [], artifactId: 'a1' },
      { kind: 'review', status: 'passed', workspaceHead: headA, warnings: ['Naming could improve'], artifactId: 'a2' },
    ];
    const projected = projectCrewRun(run, [event(2, 'workspace_advanced', { workspaceHead: headB })]);
    expect(projected.run.workspaceHead).toBe(headB);
    expect(projected.run.gates.map((gate) => gate.status)).toEqual(['stale', 'stale']);
    expect(projected.run.gates[1]?.warnings).toEqual(['Naming could improve']);
  });

  it('keeps nonblocking review warnings visible on passed current-head evidence', () => {
    const projected = projectCrewRun(base('REVIEW'), [
      event(2, 'review_completed', { status: 'passed', workspaceHead: headA, warnings: ['Consider a shorter name'], artifactId: 'review-1' }),
    ]);
    expect(projected.run.gates[0]).toMatchObject({ kind: 'review', status: 'passed', warnings: ['Consider a shorter name'] });
    expect(projected.run.status).toBe('RUNNING');
  });

  it('ignores duplicate seq and malformed future events safely', () => {
    const projected = projectCrewRun(base('BUILD'), [
      event(2, 'phase_changed', { phase: 'VERIFY' }),
      event(2, 'phase_changed', { phase: 'DONE' }),
      event(3, 'future_event', { phase: 'PUBLISH', status: 'EXPLODED' }),
      { ...event(4, 'phase_changed', {}), payload: { phase: 42 } },
    ]);
    expect(projected.run.phase).toBe('VERIFY');
    expect(projected.run.outcome).toBeNull();
  });

  it('ignores skip-shaped gate events because Crew has no exception path', () => {
    const projected = projectCrewRun(base('VERIFY'), [
      event(2, 'gate_skipped', { gate: 'verify', workspaceHead: headA }),
    ]);

    expect(projected.run.gates).toEqual([]);
    expect(projected.run.phase).toBe('VERIFY');
    expect(projected.run.outcome).toBeNull();
  });

  it('offers only typed actions valid for the current blocker or terminal state', () => {
    const clarification = base('PLAN', 'BLOCKED_USER');
    clarification.blockedReason = 'material_clarification';
    expect(projectCrewRun(clarification).actions).toEqual(['clarification', 'cancel']);
    const cap = base('VERIFY', 'BLOCKED_USER');
    cap.blockedReason = 'verify_round_cap';
    expect(projectCrewRun(cap).actions).toEqual(['extra-verify-round', 'cancel']);
    const terminal = base('DONE', 'TERMINAL');
    terminal.outcome = 'SUCCEEDED';
    expect(projectCrewRun(terminal).actions).toEqual(['successor']);
  });
});
