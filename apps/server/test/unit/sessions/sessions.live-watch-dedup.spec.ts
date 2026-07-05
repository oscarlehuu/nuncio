import { Test, TestingModule } from '@nestjs/testing';
import { Injectable } from '@nestjs/common';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { BaseAgentProvider } from '../../../src/agents/agents.base-provider';
import type { AgentRunContext } from '../../../src/agents/agents.types';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import type { ModelProviderDto } from '../../../src/models/models.types';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { PiLocalModule } from '../../../src/pi-local/pi-local.module';
import { PiLocalSessionsService } from '../../../src/pi-local/pi-local-sessions.service';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';
import { withSimulatedCursorProvider } from '../../helpers/simulated-cursor-app';

@Injectable()
class LivePiProviderForWatchTest extends BaseAgentProvider {
  readonly id = 'pi';
  readonly name = 'Pi';
  static transcriptPath = '';
  static releaseRun: (() => void) | undefined;

  constructor(sessions: SessionsRepository, events: EventsRepository) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<ModelProviderDto[]> {
    return [{ id: 'pi', name: 'Pi', groups: [{ id: 'pi', name: 'Pi', models: [] }] }];
  }

  protected async executePrompt(
    sessionId: string,
    _text: string,
    _isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    this.sessions.updateProviderRuntimeState(sessionId, {
      providerThreadId: LivePiProviderForWatchTest.transcriptPath,
    });
    this.pushEvent(sessionId, 'assistant_delta', { delta: 'Hello ' }, context.emit);
    this.pushEvent(sessionId, 'assistant_delta', { delta: 'world\n' }, context.emit);
    this.pushEvent(sessionId, 'assistant_message', { text: 'Hello world\n' }, context.emit);
    await new Promise<void>((resolve) => {
      LivePiProviderForWatchTest.releaseRun = resolve;
    });
  }
}

describe('SessionsService live Pi transcript watcher reconciliation', () => {
  let module: TestingModule;
  let service: SessionsService;
  let sessions: SessionsRepository;
  let tempDir: string;
  let dataDir: string;
  let workspace: string;
  let piPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nuncio-live-watch-'));
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-live-watch-db-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    workspace = join(tempDir, 'repo');
    piPath = join(tempDir, 'pi-session.jsonl');
    LivePiProviderForWatchTest.transcriptPath = piPath;
    LivePiProviderForWatchTest.releaseRun = undefined;
    writeFileSync(piPath, '');

    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [
          DatabaseModule,
          SessionsPersistenceModule,
          AgentsModule,
          GitModule,
          CursorLocalModule,
          PiLocalModule,
        ],
        providers: [SessionsService],
      }).overrideProvider(PiAgentProvider).useClass(LivePiProviderForWatchTest),
    ).compile();

    service = module.get(SessionsService);
    sessions = module.get(SessionsRepository);
    const piLocal = module.get(PiLocalSessionsService);
    piLocal.openSession = (path: string) => ({
      getEntries: () => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
      buildSessionContext: () => ({ model: null, thinkingLevel: null }),
    }) as never;
  });

  afterEach(async () => {
    LivePiProviderForWatchTest.releaseRun?.();
    await module.close();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('does not let the watcher re-append hydrated Pi assistant blocks while a local live run is producing', async () => {
    const session = await service.create({ provider: 'pi', prompt: 'live prompt', workspace });
    await waitFor(() => service.getEvents(session.id).some((event) => event.type === 'assistant_message'));
    await waitFor(() => service.get(session.id)?.providerThreadId === piPath);

    const unsubscribe = service.subscribe(session.id, () => undefined);
    appendFileSync(piPath, `${JSON.stringify(piMessage('user', [{ type: 'text', text: 'live prompt' }]))}\n`);
    appendFileSync(
      piPath,
      `${JSON.stringify(piMessage('assistant', [
        { type: 'text', text: 'Hello ' },
        { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'file.ts' } },
        { type: 'text', text: 'world\n' },
      ]))}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 350));
    unsubscribe();

    const assistantMessages = service
      .getEvents(session.id)
      .filter((event) => event.type === 'assistant_message')
      .map((event) => (event.payload as { text: string }).text);

    expect(assistantMessages).toEqual(['Hello world\n']);
  });

  it('does not re-append a user prompt or tool result whose live-stream payload differs from the hydrated Pi transcript', () => {
    const events = module.get(EventsRepository);
    writeFileSync(piPath, '');
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi',
      workspace,
      providerThreadId: piPath,
      prompt: 'x',
    });
    // What a live run already streamed into the DB: the prompt carries an image,
    // and the tool result is the richer streamed form. Neither matches what pi
    // writes to its transcript file byte-for-byte.
    events.appendBatch(session.id, [
      { type: 'user_message', payload: { text: 'do the thing', images: [{ mimeType: 'image/png', id: 'img-1' }] } },
      { type: 'tool_start', payload: { callId: 'call-1', tool: 'bash', input: { command: 'ls' } } },
      { type: 'tool_end', payload: { callId: 'call-1', tool: 'bash', isError: false, output: { truncated: true, preview: 'a\nb' } } },
    ]);
    // The pi transcript on disk: image-less prompt, plainer tool output.
    writeFileSync(
      piPath,
      `${JSON.stringify(piMessage('user', [{ type: 'text', text: 'do the thing' }]))}\n` +
        `${JSON.stringify(piMessage('assistant', [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }]))}\n` +
        `${JSON.stringify(piMessage('toolResult', [{ type: 'text', text: 'a\nb\n(truncated tail)' }]))}\n`,
    );
    // Force a fresh mtime so refreshTranscriptIfNeeded actually runs the diff.
    const future = new Date(Date.now() + 10_000);
    utimesSync(piPath, future, future);

    const { added } = service.refreshTranscript(session.id);

    expect(added).toBe(0);
    const types = service.getEvents(session.id).map((event) => event.type);
    expect(types.filter((type) => type === 'user_message')).toHaveLength(1);
    expect(types.filter((type) => type === 'tool_end')).toHaveLength(1);
  });

  it('still streams watcher-hydrated events for external Pi handoff sessions', async () => {
    writeFileSync(piPath, `${JSON.stringify(piMessage('user', [{ type: 'text', text: 'initial request' }]))}\n`);
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'External Pi',
      workspace,
      providerThreadId: piPath,
      prompt: 'External Pi',
    });
    expect(service.getEvents(session.id).map((event) => event.type)).toEqual(['user_message']);

    const received: SessionEvent[] = [];
    const unsubscribe = service.subscribe(session.id, (event) => received.push(event));
    appendFileSync(piPath, `${JSON.stringify(piMessage('assistant', [{ type: 'text', text: 'external reply' }]))}\n`);

    await waitFor(() => received.some((event) => event.type === 'assistant_message'));
    unsubscribe();

    expect(received).toContainEqual(
      expect.objectContaining({ type: 'assistant_message', payload: { text: 'external reply' } }),
    );
    expect(received).toContainEqual(
      expect.objectContaining({ type: 'transcript_refreshed', payload: { added: 1 } }),
    );
  });
});

function piMessage(role: 'user' | 'assistant', content: unknown[]) {
  return {
    type: 'message',
    message: { role, content },
  };
}

async function waitFor(assertion: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}
