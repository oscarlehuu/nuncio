import { describe, expect, it } from 'vitest';
import type { ResolvedCrewProfileDto } from '@nuncio/core/crew-api';
import {
  buildCrewTaskInput,
  buildSoloCreateArgs,
  createCrewSubmitLock,
  crewResolutionKey,
  crewProfileSettingsUrl,
  initialExecutionMode,
  isCrewResolutionCurrent,
  resolvedCrewTeam,
  shouldApplyCrewResolution,
} from './crew-composer';

const READY: ResolvedCrewProfileDto = {
  state: 'ready',
  issues: [],
  snapshot: {
    presetId: 'quality',
    sourceProfileId: 'quality',
    sourceProfileRevision: 4,
    resolvedAt: 1,
    bindings: {
      foreman: { provider: 'claude', model: 'fable', label: 'Planner' },
      builder: { provider: 'codex', model: 'sol' },
      reviewer: { provider: 'claude', model: 'opus', label: 'Final reviewer' },
    },
    tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
    policy: {
      verifyCommand: 'bun test',
      maxVerifyRetries: 2,
      maxReviewRetries: 2,
      strictFreshFinalReviewer: true,
    },
  },
};

describe('mobile Crew composer contracts', () => {
  it('starts every fresh composer in Solo mode', () => {
    expect(initialExecutionMode()).toBe('solo');
    expect(initialExecutionMode()).toBe('solo');
  });

  it('builds the exact existing Solo createSession arguments', () => {
    expect(buildSoloCreateArgs('  Ship it  ', { id: 'gpt-5.6', providerId: 'codex' })).toEqual([
      'Ship it',
      'gpt-5.6',
      'codex',
    ]);
    expect(buildSoloCreateArgs('  Ship it  ')).toEqual(['Ship it', undefined, undefined]);
  });

  it('builds a trimmed Crew request without leaking empty optional fields', () => {
    expect(
      buildCrewTaskInput({
        objective: '  Ship it  ',
        projectPath: '  /code/nuncio  ',
        profileId: '  quality  ',
        baseBranch: '   ',
      }),
    ).toEqual({ objective: 'Ship it', projectPath: '/code/nuncio', profileId: 'quality' });
    expect(
      buildCrewTaskInput({
        objective: 'Ship it',
        projectPath: '/code/nuncio',
        profileId: 'quality',
        baseBranch: ' dev ',
      }),
    ).toEqual({
      objective: 'Ship it',
      projectPath: '/code/nuncio',
      profileId: 'quality',
      baseBranch: 'dev',
    });
  });

  it('rejects incomplete Crew requests', () => {
    expect(buildCrewTaskInput({ objective: ' ', projectPath: '/repo', profileId: 'quality' })).toBeNull();
    expect(buildCrewTaskInput({ objective: 'Do it', projectPath: '', profileId: 'quality' })).toBeNull();
  });

  it('applies only the latest non-aborted profile resolution', () => {
    expect(shouldApplyCrewResolution(3, 4)).toBe(false);
    expect(shouldApplyCrewResolution(4, 4, true)).toBe(false);
    expect(shouldApplyCrewResolution(4, 4)).toBe(true);
  });

  it('invalidates Ready as soon as its selected profile or project changes', () => {
    const resolvedFor = crewResolutionKey('quality', '/repo-a', 'release');
    expect(isCrewResolutionCurrent(resolvedFor, 'quality', '/repo-a', 'release')).toBe(true);
    expect(isCrewResolutionCurrent(resolvedFor, 'speed', '/repo-a', 'release')).toBe(false);
    expect(isCrewResolutionCurrent(resolvedFor, 'quality', '/repo-b', 'release')).toBe(false);
    expect(isCrewResolutionCurrent(resolvedFor, 'quality', '/repo-a', 'main')).toBe(false);
  });

  it('renders the resolved team in fixed workflow order', () => {
    expect(resolvedCrewTeam(READY)).toEqual([
      'Foreman · Planner',
      'Builder · sol',
      'Tester · Nuncio Tester',
      'Reviewer · Final reviewer',
    ]);
  });

  it('locks duplicate taps synchronously and provides the web setup link', () => {
    const lock = createCrewSubmitLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(false);
    lock.release();
    expect(lock.tryAcquire()).toBe(true);
    expect(crewProfileSettingsUrl('https://hub.test/m/studio/')).toBe(
      'https://hub.test/m/studio/settings?section=crew-profiles',
    );
  });
});
