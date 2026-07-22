import { SessionsService } from '../../../src/sessions/sessions.service';
import type { AgentRegistry } from '../../../src/agents/agents.registry';
import type { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import type { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import type { ProviderRequestsRepository } from '../../../src/sessions/persistence/provider-requests.repository';
import type { SteerQueueRepository } from '../../../src/sessions/persistence/steer-queue.repository';
import type { SessionDto, SessionEvent } from '../../../src/sessions/domain/sessions.types';

function makeSession(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 'abc12345',
    title: 'Test',
    status: 'IDLE',
    provider: 'cursor',
    model: null,
    modelOptions: null,
    mode: null,
    workspace: null,
    prompt: 'hello',
    preview: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    providerThreadId: null,
    providerActiveTurnId: null,
    providerState: null,
    cursorBackend: 'sdk',
    cursorChatId: null,
    supportsInteraction: false,
    supportsInterrupt: false,
    supportsSteerWhileRunning: false,
    supportsImages: false,
    pendingInput: false,
    parentSessionId: null,
    originTaskId: null,
    priorSessionId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('SessionsService.getEvents windows', () => {
  const eventsRepo = {
    list: jest.fn().mockReturnValue([]),
    listTail: jest.fn().mockReturnValue([]),
    listBefore: jest.fn().mockReturnValue([]),
    count: jest.fn().mockReturnValue(1),
    append: jest.fn(),
  } as unknown as EventsRepository;

  const sessionsRepo = {
    findById: jest.fn().mockReturnValue(makeSession()),
    findUserFacingById: jest.fn().mockReturnValue(makeSession()),
    listUserFacing: jest.fn().mockReturnValue([]),
  } as unknown as SessionsRepository;

  const agents = {
    supportsInteractionForSession: jest.fn().mockReturnValue(false),
    resolveForSession: jest.fn().mockReturnValue({
      capabilities: {
        interrupt: false,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
    }),
  } as unknown as AgentRegistry;

  const providerRequestRecords = {
    resolveAllPending: jest.fn().mockReturnValue([]),
  } as unknown as ProviderRequestsRepository;

  const steerQueue = {
    sessionIdsWithPending: jest.fn().mockReturnValue([]),
    releaseAllClaims: jest.fn(),
  } as unknown as SteerQueueRepository;

  const service = new SessionsService(
    sessionsRepo,
    eventsRepo,
    providerRequestRecords,
    steerQueue,
    agents,
    {} as never,
    {} as never,
    { deleteSession: () => {}, read: () => null, write: () => '' } as never,
  );

  beforeEach(() => {
    (eventsRepo.list as jest.Mock).mockClear();
    (eventsRepo.listTail as jest.Mock).mockClear();
    (eventsRepo.listBefore as jest.Mock).mockClear();
  });

  it('defaults to a full ascending replay from since', () => {
    service.getEvents('abc12345', 3);
    expect(eventsRepo.list).toHaveBeenCalledWith('abc12345', 3, undefined);
  });

  it('passes limit through to the repository', () => {
    service.getEvents('abc12345', 0, { limit: 25 });
    expect(eventsRepo.list).toHaveBeenCalledWith('abc12345', 0, 25);
  });

  it('serves tail windows from listTail', () => {
    service.getEvents('abc12345', 0, { tail: 40 });
    expect(eventsRepo.listTail).toHaveBeenCalledWith('abc12345', 40);
    expect(eventsRepo.list).not.toHaveBeenCalled();
  });

  it('serves backfill pages from listBefore', () => {
    service.getEvents('abc12345', 0, { before: 90, limit: 20 });
    expect(eventsRepo.listBefore).toHaveBeenCalledWith('abc12345', 90, 20);
    expect(eventsRepo.list).not.toHaveBeenCalled();
  });

  it('onAgentEvent forwards an event that already carries its seq without re-reading the log', () => {
    const received: SessionEvent[] = [];
    // Subscribing installs a transcript watcher only when the session has a
    // transcript path; this mocked cursor/sdk session has none.
    service.subscribe('abc12345', (event) => received.push(event));

    const event = { seq: 7, type: 'assistant_delta', payload: { delta: 'x' }, createdAt: 123 };
    (service as unknown as { onAgentEvent(id: string, e: unknown): void }).onAgentEvent(
      'abc12345',
      event,
    );

    expect(received).toEqual([event]);
    expect(eventsRepo.list).not.toHaveBeenCalled();
  });
});
