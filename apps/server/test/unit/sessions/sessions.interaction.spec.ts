import { HttpException } from '@nestjs/common';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { AgentRegistry } from '../../../src/agents/agents.registry';
import type { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import type { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import type { ProviderRequestsRepository } from '../../../src/sessions/persistence/provider-requests.repository';
import type { SessionDto } from '../../../src/sessions/domain/sessions.types';

function makeSession(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 'abc12345',
    title: 'Test',
    status: 'IDLE',
    provider: 'cursor',
    model: null,
    modelOptions: null,
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
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('SessionsService interaction', () => {
  const sessionsRepo = {
    findById: jest.fn(),
  } as unknown as SessionsRepository;

  const agents = {
    supportsInteraction: jest.fn(),
    supportsInteractionForSession: jest.fn(),
    resolveForSession: jest.fn(),
  } as unknown as AgentRegistry;

  const providerRequestRecords = {
    resolveAllPending: jest.fn().mockReturnValue([]),
  } as unknown as ProviderRequestsRepository;

  const service = new SessionsService(
    sessionsRepo,
    {} as EventsRepository,
    providerRequestRecords,
    agents,
    {} as never,
    {} as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    (sessionsRepo.findById as jest.Mock).mockReturnValue(makeSession());
    (agents.supportsInteractionForSession as jest.Mock).mockReturnValue(false);
  });

  it('respondInteraction returns 501 when provider does not support interaction', async () => {
    (agents.supportsInteractionForSession as jest.Mock).mockReturnValue(false);

    await expect(
      service.respondInteraction('abc12345', 'req-1', { answers: [], resolvedBy: 'skip' }),
    ).rejects.toMatchObject({
      status: 501,
    });
    expect(agents.resolveForSession).not.toHaveBeenCalled();
  });

  it('respondInteraction returns 501 when provider omits submitInteraction', async () => {
    (agents.supportsInteractionForSession as jest.Mock).mockReturnValue(true);
    (agents.resolveForSession as jest.Mock).mockReturnValue({});

    await expect(
      service.respondInteraction('abc12345', 'req-1', { answers: [], resolvedBy: 'skip' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('enrichSession uses CLI interaction support for handoff sessions', () => {
    (sessionsRepo.findById as jest.Mock).mockReturnValue(
      makeSession({ provider: 'cursor', cursorBackend: 'cli' }),
    );
    (agents.supportsInteractionForSession as jest.Mock).mockReturnValue(true);

    const session = (service as unknown as { requireSession: (id: string) => SessionDto }).requireSession(
      'abc12345',
    );

    expect(agents.supportsInteractionForSession).toHaveBeenCalled();
    expect(session.supportsInteraction).toBe(true);
  });
});
