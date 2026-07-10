import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CrewController } from '../../../src/crew/api/crew.controller';
import { CrewService } from '../../../src/crew/crew.service';
import { DatabaseService } from '../../../src/db/database.service';
import {
  CrewNotFoundError,
  CrewRevisionConflictError,
  CrewValidationError,
} from '../../../src/crew/domain/crew-errors';

describe('CrewController', () => {
  it('emits concrete Nest injection metadata for controller and service', () => {
    expect(Reflect.getMetadata('design:paramtypes', CrewController)).toEqual([CrewService]);
    expect(Reflect.getMetadata('design:paramtypes', CrewService)?.[0]).toBe(DatabaseService);
  });

  it('wraps list/detail/create service results in stable envelopes', async () => {
    const service = {
      presets: () => [{ id: 'quality' }], listProfiles: () => [], listRunSummaries: () => [],
      createTask: () => ({ task: { id: 't1' }, run: { id: 'r1' } }),
      getTask: () => ({ task: { id: 't1' }, runs: [] }),
      getRunDetail: () => ({ run: { id: 'r1' }, members: [], results: [], artifacts: [], gates: {} }),
      listEvents: () => ({ events: [], nextSince: 0 }),
      readArtifactRange: () => ({ artifactId: 'a1', offset: 2, nextOffset: 6, eof: false, text: 'safe' }),
    };
    const controller = new CrewController(service as never);
    expect(controller.getPresets()).toEqual({ presets: [{ id: 'quality' }] });
    expect(controller.listProfiles()).toEqual({ profiles: [] });
    expect(controller.listRuns()).toEqual({ runs: [] });
    expect(await controller.createTask({ objective: 'Ship', projectPath: '/repo', profileId: 'p1' })).toEqual({
      task: { id: 't1' }, run: { id: 'r1' },
    });
    expect(controller.getTask('t1')).toEqual({ task: { id: 't1' }, runs: [] });
    expect(controller.getRun('r1')).toMatchObject({ run: { id: 'r1' }, members: [] });
    expect(controller.getEvents('r1')).toEqual({ events: [], nextSince: 0 });
    expect(controller.getArtifact('r1', 'a1', '2', '4')).toEqual({
      range: { artifactId: 'a1', offset: 2, nextOffset: 6, eof: false, text: 'safe' },
    });
  });

  it('bounds and forwards run-summary pagination instead of exposing full runs', () => {
    const listRunSummaries = jest.fn(() => []);
    const controller = new CrewController({ listRunSummaries } as never);
    expect(controller.listRuns('RUNNING', '/repo', '5', '10')).toEqual({ runs: [] });
    expect(listRunSummaries).toHaveBeenCalledWith({
      status: 'RUNNING', projectPath: '/repo', limit: 5, offset: 10,
    });
    expect(() => controller.listRuns(undefined, undefined, '101')).toThrow(BadRequestException);
  });

  it('redacts the frozen verify command from every run-bearing response', async () => {
    const verifyCommand = `TOKEN=${'s'.repeat(40)} bun test`;
    const run = { id: 'r1', revision: 4, profileSnapshot: { policy: { verifyCommand } } };
    const task = { id: 't1' };
    const controller = new CrewController({
      createTask: () => ({ task, run }),
      getTask: () => ({ task, runs: [run] }),
      getRunDetail: () => ({ run, members: [], results: [], artifacts: [], gates: {} }),
      createSuccessor: () => ({ task, run }),
      pause: () => run,
    } as never);

    const responses = [
      await controller.createTask({ objective: 'Ship', projectPath: '/repo', profileId: 'p1' }),
      controller.getTask('t1'),
      controller.getRun('r1'),
      await controller.createSuccessor('t1', {
        priorRunId: 'r0', expectedRevision: 3, expectedBaseHead: 'head', changeRequest: 'Change it',
      }),
      await controller.pause('r1', { expectedRevision: 4 }),
    ];
    expect(JSON.stringify(responses)).not.toContain(verifyCommand);
    expect(JSON.stringify(responses)).toContain('"verifyCommand":null');
  });

  it('rejects blank task/profile input and invalid retry policy', () => {
    const controller = new CrewController({ createProfile: () => ({}) } as never);
    expect(() => controller.createTask({ objective: ' ', projectPath: '/repo', profileId: 'p1' })).toThrow(BadRequestException);
    expect(() => controller.createProfile({ name: ' ', presetId: 'quality', definition: {} as never })).toThrow(BadRequestException);
    expect(() => controller.createProfile({
      name: 'Quality', presetId: 'quality',
      definition: { bindings: {} as never, policy: { maxVerifyRetries: -1 } },
    })).toThrow(BadRequestException);
  });

  it('bounds user context and rejects unsafe verifier commands before persistence', () => {
    const controller = new CrewController({ createProfile: () => ({}) } as never);
    expect(() => controller.createTask({
      objective: 'x'.repeat(16_385), projectPath: '/repo', profileId: 'p1',
    })).toThrow(BadRequestException);
    expect(() => controller.createSuccessor('t1', {
      priorRunId: 'r1', expectedRevision: 1, expectedBaseHead: 'a'.repeat(40),
      changeRequest: 'x'.repeat(16_385),
    })).toThrow(BadRequestException);
    const bindings = {
      foreman: { provider: 'claude', model: 'fable' },
      builder: { provider: 'codex', model: 'sol' },
      reviewer: { provider: 'claude', model: 'opus' },
    };
    expect(() => controller.createProfile({
      name: 'x'.repeat(257), presetId: 'quality', definition: { bindings, policy: {} } as never,
    })).toThrow(BadRequestException);
    for (const verifyCommand of ['printf ok\0leak', 'x'.repeat(4097)]) {
      expect(() => controller.createProfile({
        name: 'Quality', presetId: 'quality',
        definition: { bindings, policy: { verifyCommand } } as never,
      })).toThrow(BadRequestException);
    }
  });

  it('requires a non-negative expectedRevision for every run command', () => {
    const controller = new CrewController({} as never);
    for (const invoke of [
      () => controller.pause('r1', {} as never),
      () => controller.resume('r1', { expectedRevision: -1 }),
      () => controller.cancel('r1', { expectedRevision: Number.NaN }),
      () => controller.clarification('r1', { expectedRevision: 1, message: ' ' }),
      () => controller.extraRound('r1', { expectedRevision: 1, gate: 'publish' as never }),
    ]) expect(invoke).toThrow(BadRequestException);
  });

  it('does not expose a raw transition endpoint or forward injected event names', async () => {
    const pause = jest.fn(() => ({ id: 'r1' }));
    const controller = new CrewController({ pause } as never);
    expect('transition' in controller).toBe(false);
    expect(await controller.pause('r1', { expectedRevision: 4, type: 'synthesis_completed' } as never)).toEqual({
      run: { id: 'r1' },
    });
    expect(pause).toHaveBeenCalledWith('r1', 4);
  });

  it('maps stale revisions and missing aggregates to HTTP 409/404', async () => {
    const verifyCommand = `TOKEN=${'s'.repeat(40)} bun test`;
    const current = {
      id: 'r1', revision: 3,
      profileSnapshot: { policy: { verifyCommand } },
    };
    const conflict = new CrewRevisionConflictError('r1', 2, current as never);
    const missing = new CrewNotFoundError('run', 'missing');
    const controller = new CrewController({
      pause: () => { throw conflict; },
      getRunDetail: () => { throw missing; },
    } as never);

    try {
      await controller.pause('r1', { expectedRevision: 2 });
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const response = (error as ConflictException).getResponse();
      expect(response).toMatchObject({
        code: 'CREW_REVISION_CONFLICT', expectedRevision: 2, currentRevision: 3,
        current: { id: 'r1', revision: 3, profileSnapshot: { policy: { verifyCommand: null } } },
      });
      expect(JSON.stringify(response)).not.toContain(verifyCommand);
    }
    expect(() => controller.getRun('missing')).toThrow(NotFoundException);
  });

  it('maps artifact scope misses to 404 and invalid ranges to 400 without disclosing another run', () => {
    const missing = new CrewController({
      readArtifactRange: () => { throw new CrewNotFoundError('CrewArtifact', 'a1'); },
    } as never);
    expect(() => missing.getArtifact('run-1', 'a1')).toThrow(NotFoundException);
    const invalid = new CrewController({
      readArtifactRange: () => { throw new CrewValidationError('offset exceeds artifact byte count'); },
    } as never);
    expect(() => invalid.getArtifact('run-1', 'a1')).toThrow(BadRequestException);
  });

  it('exposes profile CRUD/resolve and immutable successor endpoints', async () => {
    const definition = {
      bindings: {
        foreman: { provider: 'claude', model: 'fable' },
        builder: { provider: 'codex', model: 'sol' },
        reviewer: { provider: 'claude', model: 'opus' },
      },
      policy: { maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true },
    };
    const service = {
      getProfile: () => ({ id: 'p1' }), updateProfile: () => ({ id: 'p1', revision: 2 }),
      deleteProfile: jest.fn(), resolveProfile: jest.fn(() => ({ state: 'ready' })),
      createSuccessor: () => ({ task: { id: 't1' }, run: { id: 'r2', priorRunId: 'r1' } }),
    };
    const controller = new CrewController(service as never);
    expect(controller.getProfile('p1')).toEqual({ profile: { id: 'p1' } });
    expect(await controller.updateProfile('p1', { expectedRevision: 1, definition })).toEqual({
      profile: { id: 'p1', revision: 2 },
    });
    expect(await controller.resolveProfile('p1', {
      projectPath: '/repo', baseBranch: 'release',
    })).toEqual({ resolution: { state: 'ready' } });
    expect(service.resolveProfile).toHaveBeenCalledWith('p1', expect.objectContaining({
      projectPath: '/repo', baseBranch: 'release',
    }));
    expect(controller.deleteProfile('p1')).toEqual({ ok: true });
    expect(await controller.createSuccessor('t1', {
      priorRunId: 'r1', expectedRevision: 9, expectedBaseHead: 'head-1', changeRequest: 'Add tests',
    })).toMatchObject({ run: { priorRunId: 'r1' } });
  });
});
