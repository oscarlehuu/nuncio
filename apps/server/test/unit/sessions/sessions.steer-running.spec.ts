import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { AgentRegistry } from '../../../src/agents/agents.registry';
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

  function stubProvider(overrides: Partial<AgentProvider> = {}): AgentProvider {
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
        sessions.updateStatus(sessionId, 'RUNNING');
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

  it('forces a hung run to IDLE when interrupt does not unwind it, then drains the queue', async () => {
    const id = seedRunning();
    const steer = jest.fn(async (_sessionId: string, _message: string) => undefined);
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

    const interrupting = service.interrupt(id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const statusWhileProviderHung = sessions.findById(id)?.status;
    releaseInterrupt();
    await interrupting;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(statusWhileProviderHung).toBe('IDLE');
    expect(events.list(id).some((event) => event.type === 'interrupted')).toBe(false);
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
        sessions.updateStatus(sessionId, 'RUNNING');
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
          sessions.updateStatus(sessionId, 'RUNNING');
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
    releaseSteer();
    await Promise.all([steering, closing]);

    expect(settledBeforeSteer).toBe(false);
  });
});
