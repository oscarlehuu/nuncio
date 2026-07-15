import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import { RetainedEventFlushError } from '../../../src/agents/agents.base-provider';
import type { AgentProvider, AgentRunContext } from '../../../src/agents/agents.types';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('SessionsService steer while RUNNING', () => {
  type TestProvider = AgentProvider & { pendingEventSessionIds?: () => string[] };
  let service: SessionsService;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let registry: AgentRegistry;
  let dataDir: string;
  let originalResolve: AgentRegistry['resolveForSession'];
  let originalResolveAvailable: AgentRegistry['resolveAvailableForSession'];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-steer-run-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();

    const module: TestingModule = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, GitModule, SessionsPersistenceModule, AgentsModule, CursorLocalModule],
        providers: [SessionsService],
      }),
    ).compile();

    service = module.get(SessionsService);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    registry = module.get(AgentRegistry);
    originalResolve = registry.resolveForSession.bind(registry);
    originalResolveAvailable = registry.resolveAvailableForSession.bind(registry);
  });

  afterAll(async () => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  afterEach(() => {
    registry.resolveForSession = originalResolve;
    registry.resolveAvailableForSession = originalResolveAvailable;
  });

  function stubProvider(overrides: Partial<TestProvider> = {}): TestProvider {
    return {
      id: 'stub',
      name: 'Stub',
      capabilities: {
        interrupt: false,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      isAvailable: async () => true,
      listModels: async () => [],
      run: async () => undefined,
      steer: async () => undefined,
      quiesce: async () => undefined,
      dispose: () => undefined,
      bustCache: () => undefined,
      ...overrides,
    };
  }

  function installProvider(provider: AgentProvider): void {
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];
    registry.resolveAvailableForSession = (async () =>
      provider) as AgentRegistry['resolveAvailableForSession'];
  }

  function seedRunning(): string {
    const created = sessions.create({ prompt: 'steer running test', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    return created.id;
  }

  it('routes a RUNNING steer to steerMidRun for a capable provider', async () => {
    const id = seedRunning();
    const steerMidRun = jest.fn(async (_sessionId: string, _message: string) => true);
    const steer = jest.fn(async () => undefined);
    installProvider(
      stubProvider({
        capabilities: {
          interrupt: true,
          modelSwitch: 'none',
          effortSwitch: 'none',
          images: false,
          steerWhileRunning: true,
        },
        steerMidRun,
        steer,
      }),
    );

    const result = await service.steer(id, 'change course');

    expect(steerMidRun).toHaveBeenCalledTimes(1);
    expect(steerMidRun.mock.calls[0]?.[0]).toBe(id);
    expect(steerMidRun.mock.calls[0]?.[1]).toBe('change course');
    expect(steer).not.toHaveBeenCalled();
    expect(result.status).toBe('RUNNING');
    expect(events.list(id).some((e) => e.type === 'steer_queued')).toBe(false);
  });

  it('queues a RUNNING steer when the provider cannot steer mid-run', async () => {
    const id = seedRunning();
    const steer = jest.fn(async () => undefined);
    installProvider(stubProvider({ steer }));

    const result = await service.steer(id, 'wait your turn');

    expect(steer).not.toHaveBeenCalled();
    expect(result.status).toBe('RUNNING');
    const queued = events.list(id).filter((e) => e.type === 'steer_queued');
    expect(queued.length).toBe(1);
    expect((queued[0].payload as { text: string }).text).toBe('wait your turn');
  });

  it('persists a background steer before returning and reports its first delivery failure', async () => {
    const created = sessions.create({ prompt: 'webhook owner', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    let deliveryAvailable = false;
    const failures: unknown[] = [];
    const recoveries: Array<Record<string, unknown>> = [];
    const steer = jest.fn(async () => {
      if (!deliveryAvailable) throw new Error('provider unavailable');
    });
    installProvider(stubProvider({ steer }));
    const stopFailureReporting = service.onBackgroundSteerFailure(({ error }) => {
      failures.push(error);
    });
    const stopRecoveryReporting = service.onBackgroundSteerDelivered(({ context }) => {
      recoveries.push(context);
    });

    try {
      service.steerInBackground(
        created.id,
        'durable webhook feedback',
        undefined,
        undefined,
        'forge:github:pr-feedback',
        { kind: 'pr-feedback', subjectId: 'octo/nuncio#7' },
      );

      expect(service.steerQueueRepository.peekNext(created.id)).toMatchObject({
        message: 'durable webhook feedback',
        origin: 'forge:github:pr-feedback',
        failureContext: { kind: 'pr-feedback', subjectId: 'octo/nuncio#7' },
      });
      const failedAt = Date.now();
      while (failures.length === 0 && Date.now() - failedAt < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(failures[0]).toBeInstanceOf(Error);
      expect(service.steerQueueRepository.peekNext(created.id)?.message)
        .toBe('durable webhook feedback');
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(failures).toHaveLength(1);
      expect(events.list(created.id).filter((event) =>
        event.type === 'error' &&
        String((event.payload as { message?: string }).message).includes('Queued message failed'),
      )).toHaveLength(1);

      deliveryAvailable = true;
      service.scheduleSteerDrain(created.id);
      const recoveredAt = Date.now();
      while (service.steerQueueRepository.peekNext(created.id) && Date.now() - recoveredAt < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(service.steerQueueRepository.peekNext(created.id)).toBeNull();
      expect(failures).toHaveLength(1);
      expect(recoveries).toEqual([{ kind: 'pr-feedback', subjectId: 'octo/nuncio#7' }]);
    } finally {
      stopFailureReporting();
      stopRecoveryReporting();
    }
  });

  it('retries failure reporting when the first handler attempt cannot persist attention', async () => {
    const created = sessions.create({ prompt: 'webhook owner', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    let deliveryAvailable = false;
    installProvider(stubProvider({
      steer: jest.fn(async () => {
        if (!deliveryAvailable) throw new Error('provider unavailable');
      }),
    }));
    let attempts = 0;
    const reported: unknown[] = [];
    const stopFailureReporting = service.onBackgroundSteerFailure(({ error }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('attention database unavailable');
      reported.push(error);
    });
    const stopRecoveryReporting = service.onBackgroundSteerDelivered(() => undefined);

    try {
      service.steerInBackground(
        created.id,
        'durable webhook feedback',
        undefined,
        undefined,
        'forge:github:pr-feedback',
        { kind: 'pr-feedback', subjectId: 'octo/nuncio#8' },
      );

      const startedAt = Date.now();
      while (reported.length === 0 && Date.now() - startedAt < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(reported).toHaveLength(1);
      deliveryAvailable = true;
      service.scheduleSteerDrain(created.id);
      const recoveredAt = Date.now();
      while (service.steerQueueRepository.peekNext(created.id) && Date.now() - recoveredAt < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(service.steerQueueRepository.peekNext(created.id)).toBeNull();
    } finally {
      stopFailureReporting();
      stopRecoveryReporting();
    }
  });

  it('keeps one background row queued while a non-live-steer provider is running', async () => {
    const id = seedRunning();
    const steer = jest.fn(async () => undefined);
    installProvider(stubProvider({ steer }));

    service.steerInBackground(id, 'wait for settle', undefined, undefined, 'forge:github:ci-failure');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(steer).not.toHaveBeenCalled();
    expect(service.steerQueueRepository.peekNext(id)).toMatchObject({
      message: 'wait for settle',
      origin: 'forge:github:ci-failure',
    });
    expect(events.list(id).filter((event) => event.type === 'steer_queued')).toHaveLength(1);
  });

  it('falls back to the queue when steerMidRun reports no live run', async () => {
    const id = seedRunning();
    const steerMidRun = jest.fn(async () => false);
    installProvider(
      stubProvider({
        capabilities: {
          interrupt: true,
          modelSwitch: 'none',
          effortSwitch: 'none',
          images: false,
          steerWhileRunning: true,
        },
        steerMidRun,
      }),
    );

    await service.steer(id, 'stale running');

    expect(steerMidRun).toHaveBeenCalledTimes(1);
    expect(events.list(id).some((e) => e.type === 'steer_queued')).toBe(true);
  });

  it('drains the queue when the foreground run reports IDLE', async () => {
    const created = sessions.create({ prompt: 'drain test', provider: 'cursor' });
    const id = created.id;
    sessions.updateStatus(id, 'RUNNING');

    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const steerCalls: string[] = [];
    const provider = stubProvider({
      steer: async (sessionId: string, message: string, context: AgentRunContext) => {
        steerCalls.push(message);
        if (sessions.findById(sessionId)?.status !== 'RUNNING') sessions.updateStatus(sessionId, 'RUNNING');
        if (steerCalls.length === 1) await runGate;
        sessions.updateStatus(sessionId, 'IDLE');
        context.emit?.(events.append(sessionId, 'status', { status: 'IDLE' }));
      },
    });
    installProvider(provider);

    // Move the session to IDLE so the first steer takes the foreground path.
    sessions.updateStatus(id, 'IDLE');
    const first = service.steer(id, 'first message');
    // Give the foreground steer a beat to mark the session RUNNING.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessions.findById(id)?.status).toBe('RUNNING');

    // Second steer arrives mid-run: must queue, not reject.
    await service.steer(id, 'second message');
    expect(events.list(id).some((e) => e.type === 'steer_queued')).toBe(true);
    expect(steerCalls).toEqual(['first message']);

    releaseRun();
    await first;
    // Drain happens on the IDLE status event, one tick later.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(steerCalls).toEqual(['first message', 'second message']);
  });

  it('claims RUNNING before provider availability so concurrent IDLE steers cannot overlap', async () => {
    const created = sessions.create({ prompt: 'concurrent idle steers', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    const steer = jest.fn(async () => undefined);
    const provider = stubProvider({ steer });
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];
    let releaseAvailability: () => void = () => undefined;
    registry.resolveAvailableForSession = (async () => {
      await new Promise<void>((resolve) => { releaseAvailability = resolve; });
      return provider;
    }) as AgentRegistry['resolveAvailableForSession'];

    const first = service.steer(created.id, 'first');
    await Promise.resolve();
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
    const second = service.steer(created.id, 'second');
    releaseAvailability();
    await Promise.all([first, second]);

    expect(steer).toHaveBeenCalledTimes(1);
    expect(events.list(created.id).filter((event) => event.type === 'steer_queued')).toHaveLength(1);
  });

  it('returns an IDLE claim when provider preflight flush rejects', async () => {
    const created = sessions.create({ prompt: 'preflight flush failure', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    installProvider(stubProvider({
      steer: async () => { throw new RetainedEventFlushError(new Error('tail still pending')); },
    }));

    await expect(service.steer(created.id, 'retry later')).rejects.toThrow('tail still pending');
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
  });

  it('restores PAUSED when provider availability fails before a steer starts', async () => {
    const created = sessions.create({ prompt: 'paused preflight failure', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    sessions.updateStatus(created.id, 'PAUSED');
    const provider = stubProvider();
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];
    registry.resolveAvailableForSession = (async () => {
      throw new Error('provider unavailable');
    }) as AgentRegistry['resolveAvailableForSession'];

    await expect(service.steer(created.id, 'stay paused')).rejects.toThrow('provider unavailable');
    expect(sessions.findById(created.id)?.status).toBe('PAUSED');
  });

  it('does not drain a concurrent steer after the user pauses during a failed preflight', async () => {
    const created = sessions.create({ prompt: 'pause during preflight', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    const steer = jest.fn(async (sessionId: string) => {
      sessions.updateStatus(sessionId, 'RUNNING');
    });
    const provider = stubProvider({ steer });
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];
    let rejectAvailability: (error: Error) => void = () => undefined;
    let availabilityCalls = 0;
    registry.resolveAvailableForSession = (async () => {
      availabilityCalls += 1;
      if (availabilityCalls === 1) {
        await new Promise<void>((_resolve, reject) => { rejectAvailability = reject; });
      }
      return provider;
    }) as AgentRegistry['resolveAvailableForSession'];

    const first = service.steer(created.id, 'first');
    await Promise.resolve();
    await service.steer(created.id, 'keep queued');
    service.pause(created.id);
    rejectAvailability(new Error('provider unavailable'));
    await expect(first).rejects.toThrow('provider unavailable');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(sessions.findById(created.id)?.status).toBe('PAUSED');
    expect(steer).not.toHaveBeenCalled();
    expect(availabilityCalls).toBe(1);
  });

  it('drains a concurrent steer when a PAUSED start fails without a newer lifecycle action', async () => {
    const created = sessions.create({ prompt: 'paused failed start', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    sessions.updateStatus(created.id, 'PAUSED');
    const steer = jest.fn(async () => undefined);
    const provider = stubProvider({ steer });
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];
    let rejectAvailability: (error: Error) => void = () => undefined;
    let availabilityCalls = 0;
    registry.resolveAvailableForSession = (async () => {
      availabilityCalls += 1;
      if (availabilityCalls === 1) {
        await new Promise<void>((_resolve, reject) => { rejectAvailability = reject; });
      }
      return provider;
    }) as AgentRegistry['resolveAvailableForSession'];

    const first = service.steer(created.id, 'first');
    await Promise.resolve();
    await service.steer(created.id, 'second');
    rejectAvailability(new Error('provider unavailable'));
    await expect(first).rejects.toThrow('provider unavailable');
    const started = Date.now();
    while (steer.mock.calls.length < 1 && Date.now() - started < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(steer).toHaveBeenCalledWith(created.id, 'second', expect.any(Object));
  });

  it('drains a concurrent steer after the provider rejects the claimed start', async () => {
    const created = sessions.create({ prompt: 'rejected claimed start', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    let releaseFirst: () => void = () => undefined;
    const steer = jest.fn(async (_sessionId: string, _message: string) => {
      if (steer.mock.calls.length === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        throw new RetainedEventFlushError(new Error('retained tail unavailable'));
      }
    });
    installProvider(stubProvider({ steer }));

    const first = service.steer(created.id, 'first');
    await Promise.resolve();
    await service.steer(created.id, 'second');
    releaseFirst();
    await expect(first).rejects.toThrow('retained tail unavailable');
    const started = Date.now();
    while (steer.mock.calls.length < 2 && Date.now() - started < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(steer).toHaveBeenCalledTimes(2);
    expect(steer.mock.calls[1]?.[1]).toBe('second');
  });

  it('keeps a queued steer durable across repeated delivery failures', async () => {
    const created = sessions.create({ prompt: 'repeated failed delivery', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    let releaseFirst: () => void = () => undefined;
    let deliveryAvailable = false;
    const steer = jest.fn(async () => {
      if (steer.mock.calls.length === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      if (!deliveryAvailable) {
        throw new RetainedEventFlushError(new Error('storage still unavailable'));
      }
    });
    installProvider(stubProvider({ steer }));

    const first = service.steer(created.id, 'first');
    await Promise.resolve();
    await service.steer(created.id, 'must survive');
    releaseFirst();
    await expect(first).rejects.toThrow('storage still unavailable');
    const started = Date.now();
    while (steer.mock.calls.length < 2 && Date.now() - started < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(service.steerQueueRepository.peekNext(created.id)?.message).toBe('must survive');
    deliveryAvailable = true;
    service.scheduleSteerDrain(created.id);
    const recovered = Date.now();
    while (steer.mock.calls.length < 3 && Date.now() - recovered < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    while (service.steerQueueRepository.peekNext(created.id) && Date.now() - recovered < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(steer.mock.calls[2]).toEqual([created.id, 'must survive', expect.any(Object)]);
    expect(service.steerQueueRepository.peekNext(created.id)).toBeNull();
  });

  it('retries queue acknowledgement without redelivering an accepted steer', async () => {
    const created = sessions.create({ prompt: 'ack retry', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    service.steerQueueRepository.enqueue(created.id, 'deliver once');
    const steer = jest.fn(async () => undefined);
    installProvider(stubProvider({ steer }));
    const originalAcknowledge = service.steerQueueRepository.acknowledgeDelivered.bind(
      service.steerQueueRepository,
    );
    let deleteCalls = 0;
    const deleteSpy = jest
      .spyOn(service.steerQueueRepository, 'acknowledgeDelivered')
      .mockImplementation((rowId, onRecovered) => {
        deleteCalls += 1;
        if (deleteCalls === 1) throw new Error('sqlite temporarily unavailable');
        return originalAcknowledge(rowId, onRecovered);
      });

    try {
      service.scheduleSteerDrain(created.id);
      const started = Date.now();
      while (service.steerQueueRepository.peekNext(created.id) && Date.now() - started < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(steer).toHaveBeenCalledTimes(1);
      expect(deleteCalls).toBeGreaterThanOrEqual(2);
      expect(service.steerQueueRepository.peekNext(created.id)).toBeNull();
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it('does not retry a failed queued delivery after a newer pause wins', async () => {
    const created = sessions.create({ prompt: 'pause wins retry', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    service.steerQueueRepository.enqueue(created.id, 'stay paused');
    let releaseDelivery: () => void = () => undefined;
    const steer = jest.fn(async () => {
      await new Promise<void>((resolve) => { releaseDelivery = resolve; });
      throw new RetainedEventFlushError(new Error('delivery failed'));
    });
    installProvider(stubProvider({ steer }));

    service.scheduleSteerDrain(created.id);
    const started = Date.now();
    while (steer.mock.calls.length < 1 && Date.now() - started < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    service.pause(created.id);
    releaseDelivery();
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(sessions.findById(created.id)?.status).toBe('PAUSED');
    expect(steer).toHaveBeenCalledTimes(1);
    expect(service.steerQueueRepository.peekNext(created.id)?.message).toBe('stay paused');
  });

  it('cancels an already-scheduled queue retry when the user pauses during backoff', async () => {
    const created = sessions.create({ prompt: 'pause during retry backoff', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    service.steerQueueRepository.enqueue(created.id, 'stay paused after failure');
    const steer = jest.fn(async () => {
      throw new RetainedEventFlushError(new Error('delivery failed'));
    });
    installProvider(stubProvider({ steer }));

    service.scheduleSteerDrain(created.id);
    const started = Date.now();
    while (steer.mock.calls.length < 1 && Date.now() - started < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    service.pause(created.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(sessions.findById(created.id)?.status).toBe('PAUSED');
    expect(steer).toHaveBeenCalledTimes(1);
    expect(service.steerQueueRepository.peekNext(created.id)?.message)
      .toBe('stay paused after failure');
  });

  it('keeps a queue retry blocked while the requested pause is still pending', async () => {
    const created = sessions.create({ prompt: 'pending pause during backoff', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    service.steerQueueRepository.enqueue(created.id, 'wait for pending pause');
    let teardownBlocked = true;
    const steer = jest.fn(async () => {
      throw new RetainedEventFlushError(new Error('delivery failed'));
    });
    installProvider(stubProvider({
      steer,
      dispose: () => {
        if (teardownBlocked) throw new RetainedEventFlushError(new Error('tail pending'));
      },
    }));

    service.scheduleSteerDrain(created.id);
    const started = Date.now();
    while (steer.mock.calls.length < 1 && Date.now() - started < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.pause(created.id).status).toBe('IDLE');

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(steer).toHaveBeenCalledTimes(1);
      expect(service.steerQueueRepository.peekNext(created.id)?.message)
        .toBe('wait for pending pause');
    } finally {
      teardownBlocked = false;
      const settling = Date.now();
      while (sessions.findById(created.id)?.status !== 'PAUSED' && Date.now() - settling < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(sessions.findById(created.id)?.status).toBe('PAUSED');
  });

  it('backs off one failed queue delivery instead of scheduling a zero-delay retry', async () => {
    const created = sessions.create({ prompt: 'queue backoff', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    service.steerQueueRepository.enqueue(created.id, 'retry later');
    const steer = jest.fn(async () => {
      throw new RetainedEventFlushError(new Error('still unavailable'));
    });
    installProvider(stubProvider({ steer }));

    service.scheduleSteerDrain(created.id);
    const started = Date.now();
    while (steer.mock.calls.length < 1 && Date.now() - started < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(steer).toHaveBeenCalledTimes(1);
    expect(service.steerQueueRepository.peekNext(created.id)?.message).toBe('retry later');
    // Keep this intentionally durable row inert after the assertion; the
    // scheduled retry must observe the newer lifecycle state.
    service.pause(created.id);
  });

  it('tracks availability preflight and prevents provider work after shutdown starts', async () => {
    const created = sessions.create({ prompt: 'shutdown preflight', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    const steer = jest.fn(async () => undefined);
    const provider = stubProvider({ steer });
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];
    let releaseAvailability: () => void = () => undefined;
    const availability = new Promise<AgentProvider>((resolve) => {
      releaseAvailability = () => resolve(provider);
    });
    registry.resolveAvailableForSession = (() => availability) as AgentRegistry['resolveAvailableForSession'];
    const internals = service as unknown as {
      destroyed: boolean;
      pendingWork: Set<Promise<unknown>>;
    };

    const steering = service.steer(created.id, 'must not start');
    await Promise.resolve();
    expect(internals.pendingWork.has(availability)).toBe(true);
    internals.destroyed = true;
    releaseAvailability();
    await expect(steering).rejects.toThrow('shutting down');
    expect(steer).not.toHaveBeenCalled();
    internals.destroyed = false;
  });

  it('dedupes steer_message against hydrated user_message on transcript refresh', () => {
    const created = sessions.create({ prompt: 'dedupe test', provider: 'cursor' });
    events.append(created.id, 'steer_message', { text: 'follow the plan' });

    const missing = (
      service as unknown as {
        missingTranscriptEvents: (
          id: string,
          hydrated: Array<{ type: string; payload: unknown }>,
        ) => Array<{ type: string; payload: unknown }>;
      }
    ).missingTranscriptEvents(created.id, [
      { type: 'user_message', payload: { text: 'follow the plan' } },
    ]);

    expect(missing).toEqual([]);
  });

  it('still rejects steer for ARCHIVED sessions', async () => {
    const created = sessions.create({ prompt: 'archived', provider: 'cursor' });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateStatus(created.id, 'IDLE');
    sessions.updateStatus(created.id, 'ARCHIVED');
    installProvider(stubProvider());

    await expect(service.steer(created.id, 'too late')).rejects.toThrow();
  });

  it('appends an interrupted event after a successful interrupt', async () => {
    const id = seedRunning();
    const interrupt = jest.fn(async () => undefined);
    installProvider(
      stubProvider({
        capabilities: {
          interrupt: true,
          modelSwitch: 'none',
          effortSwitch: 'none',
          images: false,
          steerWhileRunning: false,
        },
        interrupt,
      }),
    );

    await service.interrupt(id);

    expect(interrupt).toHaveBeenCalledWith(id);
    expect(events.list(id).some((e) => e.type === 'interrupted')).toBe(true);
  });

  it('appends an interrupted event when IDLE wins the provider settlement race', async () => {
    const id = seedRunning();
    let releaseInterrupt: () => void = () => undefined;
    const interrupt = jest.fn(async () => {
      sessions.updateStatus(id, 'IDLE');
      const settled = events.append(id, 'status', { status: 'IDLE' });
      (
        service as unknown as {
          onAgentEvent: (sessionId: string, event: typeof settled) => void;
        }
      ).onAgentEvent(id, settled);
      await new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      });
    });
    installProvider(
      stubProvider({
        capabilities: {
          interrupt: true,
          modelSwitch: 'none',
          effortSwitch: 'none',
          images: false,
          steerWhileRunning: false,
        },
        interrupt,
      }),
    );

    const interrupting = service.interrupt(id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events.list(id).some((event) => event.type === 'interrupted')).toBe(true);
    releaseInterrupt();
    await interrupting;
  });

  it('forces a hung run to IDLE when interrupt does not unwind it, then drains the queue', async () => {
    const id = seedRunning();
    const steer = jest.fn(async (sessionId: string, _message: string, context: AgentRunContext) => {
      if (sessions.findById(sessionId)?.status !== 'RUNNING') {
        sessions.updateStatus(sessionId, 'RUNNING');
      }
      sessions.updateStatus(sessionId, 'IDLE');
      context.emit?.(events.append(sessionId, 'status', { status: 'IDLE' }));
    });
    installProvider(
      stubProvider({
        capabilities: {
          interrupt: true,
          modelSwitch: 'none',
          effortSwitch: 'none',
          images: false,
          steerWhileRunning: false,
        },
        // Interrupt "succeeds" but the provider run never unwinds (hung stream).
        interrupt: async () => undefined,
        steer,
      }),
    );
    (service as unknown as { interruptForceIdleMs: number }).interruptForceIdleMs = 20;

    await service.steer(id, 'queued while hung');
    await service.interrupt(id);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(sessions.findById(id)?.status).toBe('IDLE');
    // The force-idle transition also delivers what was queued.
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]?.[1]).toBe('queued while hung');
  });

  it('arms force-idle before awaiting a provider interrupt that hangs', async () => {
    const id = seedRunning();
    let releaseInterrupt: () => void = () => undefined;
    const interrupt = jest.fn(
      async () => new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      }),
    );
    installProvider(
      stubProvider({
        capabilities: {
          interrupt: true,
          modelSwitch: 'none',
          effortSwitch: 'none',
          images: false,
          steerWhileRunning: false,
        },
        interrupt,
      }),
    );
    (service as unknown as { interruptForceIdleMs: number }).interruptForceIdleMs = 20;

    let interruptSettled = false;
    const interrupting = service.interrupt(id).then(() => {
      interruptSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const statusWhileProviderHung = sessions.findById(id)?.status;
    const settledWhileProviderHung = interruptSettled;
    releaseInterrupt();
    await interrupting;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(statusWhileProviderHung).toBe('IDLE');
    expect(settledWhileProviderHung).toBe(true);
    expect(events.list(id).some((event) => event.type === 'interrupted')).toBe(false);
  });

  it('force-idles after one permanent provider disposal failure', async () => {
    const id = seedRunning();
    const dispose = jest.fn(() => {
      throw new Error('runtime disposal failed');
    });
    installProvider(
      stubProvider({
        capabilities: {
          interrupt: true,
          modelSwitch: 'none',
          effortSwitch: 'none',
          images: false,
          steerWhileRunning: false,
        },
        interrupt: async () => undefined,
        dispose,
      }),
    );
    (service as unknown as { interruptForceIdleMs: number }).interruptForceIdleMs = 20;

    await service.interrupt(id);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(sessions.findById(id)?.status).toBe('IDLE');
  });

  it('retries a force-idle transition after its status event append fails', async () => {
    const id = seedRunning();
    installProvider(stubProvider({
      capabilities: {
        interrupt: true,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      interrupt: async () => undefined,
    }));
    (service as unknown as { interruptForceIdleMs: number }).interruptForceIdleMs = 20;
    const originalAppend = events.append.bind(events);
    let failures = 1;
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'status' && (payload as { status?: string }).status === 'IDLE' && failures-- > 0) {
        throw new Error('status event temporarily unavailable');
      }
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    try {
      await service.interrupt(id);
      await new Promise((resolve) => setTimeout(resolve, 220));
      expect(sessions.findById(id)?.status).toBe('IDLE');
      expect(events.list(id).filter(
        (event) => event.type === 'status' && (event.payload as { status?: string }).status === 'IDLE',
      )).toHaveLength(1);
    } finally {
      events.append = originalAppend as EventsRepository['append'];
    }
  });

  it('does not force-idle the run later when the provider interrupt rejects', async () => {
    const id = seedRunning();
    const dispose = jest.fn();
    installProvider(
      stubProvider({
        capabilities: {
          interrupt: true,
          modelSwitch: 'none',
          effortSwitch: 'none',
          images: false,
          steerWhileRunning: false,
        },
        interrupt: async () => {
          throw new Error('interrupt failed');
        },
        dispose,
      }),
    );
    (service as unknown as { interruptForceIdleMs: number }).interruptForceIdleMs = 20;

    await expect(service.interrupt(id)).rejects.toThrow('interrupt failed');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sessions.findById(id)?.status).toBe('RUNNING');
    expect(dispose).not.toHaveBeenCalled();
  });

  it('keeps force-idle recovery armed when interrupt rejects after teardown starts', async () => {
    const id = seedRunning();
    let rejectInterrupt: (error: Error) => void = () => undefined;
    let disposeCalls = 0;
    installProvider(stubProvider({
      capabilities: {
        interrupt: true,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      interrupt: async () => new Promise<void>((_resolve, reject) => {
        rejectInterrupt = reject;
      }),
      dispose: () => {
        disposeCalls += 1;
        if (disposeCalls === 1) throw new RetainedEventFlushError(new Error('tail pending'));
      },
    }));
    (service as unknown as { interruptForceIdleMs: number }).interruptForceIdleMs = 20;

    const interrupting = service.interrupt(id);
    await new Promise((resolve) => setTimeout(resolve, 35));
    rejectInterrupt(new Error('late interrupt failure'));
    await expect(interrupting).rejects.toThrow('late interrupt failure');
    await new Promise((resolve) => setTimeout(resolve, 280));

    expect(disposeCalls).toBeGreaterThanOrEqual(2);
    expect(sessions.findById(id)?.status).toBe('IDLE');
  });

  it('keeps shutdown disposal best-effort when an active-session lookup fails', () => {
    const id = seedRunning();
    const internals = service as unknown as {
      locallyProducing: Set<string>;
      disposeActiveTurns: () => void;
    };
    internals.locallyProducing.add(id);
    const originalFind = sessions.findById.bind(sessions);
    sessions.findById = (() => {
      throw new Error('sqlite read failed');
    }) as SessionsRepository['findById'];
    try {
      expect(() => internals.disposeActiveTurns()).not.toThrow();
    } finally {
      sessions.findById = originalFind as SessionsRepository['findById'];
      internals.locallyProducing.delete(id);
    }
  });

  it('keeps shutdown provider collection best-effort when an active-session lookup fails', () => {
    const id = seedRunning();
    const internals = service as unknown as {
      locallyProducing: Set<string>;
      registeredProviders: () => Set<AgentProvider>;
    };
    internals.locallyProducing.add(id);
    const originalFind = sessions.findById.bind(sessions);
    sessions.findById = (() => { throw new Error('sqlite read failed'); }) as SessionsRepository['findById'];
    try {
      expect(() => internals.registeredProviders()).not.toThrow();
    } finally {
      sessions.findById = originalFind as SessionsRepository['findById'];
      internals.locallyProducing.delete(id);
    }
  });

  it('cancels the old force-idle timer when the interrupted run settles', async () => {
    const id = seedRunning();
    let releaseReplacement: () => void = () => undefined;
    const provider = stubProvider({
      capabilities: {
        interrupt: true,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      interrupt: async () => {
        sessions.updateStatus(id, 'IDLE');
        const settled = events.append(id, 'status', { status: 'IDLE' });
        (
          service as unknown as {
            onAgentEvent: (sessionId: string, event: typeof settled) => void;
          }
        ).onAgentEvent(id, settled);
      },
      steer: async (sessionId: string) => {
        if (sessions.findById(sessionId)?.status !== 'RUNNING') sessions.updateStatus(sessionId, 'RUNNING');
        await new Promise<void>((resolve) => {
          releaseReplacement = resolve;
        });
        if (sessions.findById(sessionId)?.status === 'RUNNING') {
          sessions.updateStatus(sessionId, 'IDLE');
        }
      },
    });
    installProvider(provider);
    (service as unknown as { interruptForceIdleMs: number }).interruptForceIdleMs = 30;

    await service.interrupt(id);
    const replacement = service.steer(id, 'replacement after interrupt');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const replacementStatus = sessions.findById(id)?.status;
    releaseReplacement();
    await replacement;

    expect(replacementStatus).toBe('RUNNING');
    expect(events.list(id).some((event) => event.type === 'interrupted')).toBe(true);
  });

  it('auto force-idles a silent stalled run after a long timeout, then drains the queue', async () => {
    const steer = jest.fn(async (_sessionId: string, _message: string) => undefined);
    const dispose = jest.fn();
    installProvider(
      stubProvider({
        run: async (sessionId: string, _prompt: string, context: AgentRunContext) => {
          if (sessions.findById(sessionId)?.status !== 'RUNNING') sessions.updateStatus(sessionId, 'RUNNING');
          context.emit?.(events.append(sessionId, 'status', { status: 'RUNNING' }));
          context.emit?.(events.append(sessionId, 'assistant_delta', { delta: 'partial' }));
          await new Promise(() => undefined);
        },
        steer,
        dispose,
      }),
    );
    (service as unknown as { stalledRunForceIdleMs: number }).stalledRunForceIdleMs = 20;

    const created = await service.create({ prompt: 'stalled run', provider: 'cursor' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sessions.findById(created.id)?.status).toBe('RUNNING');

    await service.steer(created.id, 'queued while stalled');
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(dispose).toHaveBeenCalledWith(created.id);
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
    expect(events.list(created.id).some((e) => e.type === 'runtime_stalled')).toBe(true);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]?.[1]).toBe('queued while stalled');
  });

  it('retries only the stalled-run IDLE transition after a transient status append failure', async () => {
    installProvider(stubProvider({
      run: async (sessionId: string, _prompt: string, context: AgentRunContext) => {
        if (sessions.findById(sessionId)?.status !== 'RUNNING') sessions.updateStatus(sessionId, 'RUNNING');
        context.emit?.(events.append(sessionId, 'status', { status: 'RUNNING' }));
        await new Promise(() => undefined);
      },
    }));
    (service as unknown as { stalledRunForceIdleMs: number }).stalledRunForceIdleMs = 20;
    const originalAppend = events.append.bind(events);
    let failures = 1;
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'status' && (payload as { status?: string }).status === 'IDLE' && failures-- > 0) {
        throw new Error('status event temporarily unavailable');
      }
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    try {
      const created = await service.create({ prompt: 'stalled transition retry', provider: 'cursor' });
      await new Promise((resolve) => setTimeout(resolve, 320));
      expect(sessions.findById(created.id)?.status).toBe('IDLE');
      expect(events.list(created.id).filter((event) => event.type === 'runtime_stalled')).toHaveLength(1);
    } finally {
      events.append = originalAppend as EventsRepository['append'];
    }
  });

  it('stalled-run recovery does not retry a permanent provider disposal failure', async () => {
    const dispose = jest.fn(() => {
      throw new Error('runtime disposal failed');
    });
    installProvider(
      stubProvider({
        run: async (sessionId: string, _prompt: string, context: AgentRunContext) => {
          if (sessions.findById(sessionId)?.status !== 'RUNNING') sessions.updateStatus(sessionId, 'RUNNING');
          context.emit?.(events.append(sessionId, 'status', { status: 'RUNNING' }));
          await new Promise(() => undefined);
        },
        dispose,
      }),
    );
    (service as unknown as { stalledRunForceIdleMs: number }).stalledRunForceIdleMs = 20;

    const created = await service.create({ prompt: 'permanent dispose failure', provider: 'cursor' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
    expect(events.list(created.id).some((event) => event.type === 'runtime_stalled')).toBe(true);
  });

  it('exposes interrupt and steer-while-running capabilities on the session DTO', async () => {
    const id = seedRunning();
    installProvider(
      stubProvider({
        capabilities: {
          interrupt: true,
          modelSwitch: 'none',
          effortSwitch: 'none',
          images: false,
          steerWhileRunning: true,
        },
      }),
    );

    const dto = service.get(id);
    expect(dto?.supportsInterrupt).toBe(true);
    expect(dto?.supportsSteerWhileRunning).toBe(true);
  });

  it('keeps a direct mid-run steer in the bounded shutdown drain', async () => {
    const internals = service as unknown as {
      runPromises: Map<string, Promise<void>>;
      pendingWork: Set<Promise<unknown>>;
      locallyProducing: Set<string>;
      shutdownDrainTimeoutMs: number;
    };
    // Earlier cases deliberately leave a never-resolving provider run behind.
    // Remove that unrelated fixture so only this direct steer can hold close.
    internals.runPromises.clear();
    internals.pendingWork.clear();
    internals.locallyProducing.clear();
    const id = seedRunning();
    let releaseSteer: () => void = () => undefined;
    let startedSteer: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      startedSteer = resolve;
    });
    const cancelPendingEventRetries = jest.fn();
    const flushPendingEvents = jest.fn();
    let retainedTail = true;
    let disposeAttempts = 0;
    installProvider(
      stubProvider({
        capabilities: {
          interrupt: true,
          modelSwitch: 'none',
          effortSwitch: 'none',
          images: false,
          steerWhileRunning: true,
        },
        steerMidRun: async () => {
          startedSteer();
          return new Promise<boolean>((resolve) => {
            releaseSteer = () => resolve(true);
          });
        },
        interrupt: async () => undefined,
        dispose: () => {
          disposeAttempts += 1;
          if (disposeAttempts === 1) {
            throw new RetainedEventFlushError(new Error('one-off shutdown failure'));
          }
        },
        pendingEventSessionIds: () => (retainedTail ? [id] : []),
        flushPendingEvents: () => {
          flushPendingEvents();
          retainedTail = false;
        },
        cancelPendingEventRetries: () => {
          cancelPendingEventRetries();
          retainedTail = false;
        },
      }),
    );
    internals.shutdownDrainTimeoutMs = 1000;

    const steering = service.steer(id, 'in-flight shutdown steer');
    await started;
    let closeSettled = false;
    const closing = service.onModuleDestroy().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const settledBeforeSteer = closeSettled;
    const cancelledBeforeDrain = cancelPendingEventRetries.mock.calls.length;
    releaseSteer();
    await Promise.all([steering, closing]);

    expect(settledBeforeSteer).toBe(false);
    expect(cancelledBeforeDrain).toBe(0);
    expect(flushPendingEvents).toHaveBeenCalledWith();
    expect(retainedTail).toBe(false);
  });
});
