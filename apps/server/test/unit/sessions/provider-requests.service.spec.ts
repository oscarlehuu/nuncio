import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import { CursorLocalSessionsService } from '../../../src/cursor-local/cursor-local-sessions.service';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitService } from '../../../src/git/git.service';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';

describe('SessionsService provider requests', () => {
  let module: TestingModule;
  let service: SessionsService;
  let sessions: SessionsRepository;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-provider-requests-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
      providers: [
        SessionsService,
        { provide: AgentRegistry, useValue: { supportsInteractionForSession: () => false } },
        { provide: GitService, useValue: {} },
        { provide: CursorLocalSessionsService, useValue: {} },
      ],
    }).compile();

    service = module.get(SessionsService);
    sessions = module.get(SessionsRepository);
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('creates a pending provider request event and resolves it with a user decision', async () => {
    const session = sessions.create({ id: 's-approval', prompt: 'needs approval', provider: 'codex' });
    const streamed: SessionEvent[] = [];
    const unsubscribe = service.subscribe(session.id, (event) => streamed.push(event));

    const pending = service.requestProviderApproval(session.id, {
      provider: 'codex',
      method: 'exec/approval',
      params: { command: 'git status' },
    });

    const requestEvent = service.getEvents(session.id).find((event) => event.type === 'provider_request');
    expect(requestEvent?.payload).toMatchObject({
      provider: 'codex',
      method: 'exec/approval',
      status: 'pending',
      params: { command: 'git status' },
    });
    const requestId = (requestEvent?.payload as { requestId: string }).requestId;

    const response = service.respondProviderRequest(session.id, requestId, 'approve');

    await expect(pending).resolves.toEqual({ requestId, decision: 'approve' });
    expect(response).toEqual({ requestId, decision: 'approve' });
    expect(service.getEvents(session.id).at(-1)).toMatchObject({
      type: 'provider_request_resolved',
      payload: {
        requestId,
        provider: 'codex',
        method: 'exec/approval',
        decision: 'approve',
        status: 'resolved',
      },
    });
    expect(streamed.map((event) => event.type)).toEqual([
      'provider_request',
      'provider_request_resolved',
    ]);
    unsubscribe();
  });

  it('marks persisted pending provider requests denied when the server restarts', async () => {
    const session = sessions.create({ id: 's-restart', prompt: 'restart approval', provider: 'codex' });
    void service.requestProviderApproval(session.id, {
      provider: 'codex',
      method: 'exec/approval',
      params: { command: 'cat package.json' },
    });
    const requestEvent = service.getEvents(session.id).find((event) => event.type === 'provider_request');
    const requestId = (requestEvent?.payload as { requestId: string }).requestId;

    await module.close();
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
      providers: [
        SessionsService,
        { provide: AgentRegistry, useValue: { supportsInteractionForSession: () => false } },
        { provide: GitService, useValue: {} },
        { provide: CursorLocalSessionsService, useValue: {} },
      ],
    }).compile();
    service = module.get(SessionsService);
    sessions = module.get(SessionsRepository);

    expect(service.getEvents(session.id).at(-1)).toMatchObject({
      type: 'provider_request_resolved',
      payload: {
        requestId,
        provider: 'codex',
        method: 'exec/approval',
        decision: 'deny',
        status: 'resolved',
        reason: 'server_restarted',
      },
    });
    expect(() => service.respondProviderRequest(session.id, requestId, 'approve')).toThrow(
      NotFoundException,
    );
  });

  it('rejects invalid provider request decisions before looking up the request', () => {
    expect(() =>
      service.respondProviderRequest('s1', 'missing-request', 'maybe' as never),
    ).toThrow(BadRequestException);
  });

  it('throws when a provider request is not pending for that session', () => {
    const session = sessions.create({ id: 's-owned', prompt: 'owned', provider: 'codex' });
    expect(() => service.respondProviderRequest(session.id, 'missing-request', 'deny')).toThrow(
      NotFoundException,
    );
  });
});
