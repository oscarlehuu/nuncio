import { Test, TestingModule } from '@nestjs/testing';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { PiLocalModule } from '../../../src/pi-local/pi-local.module';
import { PiLocalSessionsService } from '../../../src/pi-local/pi-local-sessions.service';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';
import { withSimulatedCursorProvider } from '../../helpers/simulated-cursor-app';

describe('SessionsService transcript file watcher', () => {
  let module: TestingModule;
  let service: SessionsService;
  let sessions: SessionsRepository;
  let tempDir: string;
  let dataDir: string;
  let workspace: string;
  let piPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nuncio-transcript-watch-'));
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-transcript-watch-db-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    workspace = join(tempDir, 'repo');
    piPath = join(tempDir, 'pi-session.jsonl');
    writeFileSync(piPath, `${JSON.stringify(piMessage('user', 'initial request'))}\n`);

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
      }),
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
    await module.close();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('streams appended Pi transcript events without manually refreshing and stops watching after unsubscribe', async () => {
    const watcher = installDeterministicTranscriptWatcher(service);
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi watch',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi watch',
    });
    expect(service.getEvents(session.id).map((event) => event.type)).toEqual(['user_message']);

    const received: SessionEvent[] = [];
    const unsubscribe = service.subscribe(session.id, (event) => received.push(event));
    // Drive refreshes only through the deterministic fire() below; stop the real
    // interval poller so it can't race the appended-line assertions under load.
    watcher.get(session.id)?.disablePolling();

    appendFileSync(piPath, `${JSON.stringify(piMessage('assistant', 'live reply'))}\n`);
    bumpMtime(piPath);
    watcher.get(session.id)?.fire();

    await waitFor(() => received.some((event) => event.type === 'assistant_message'));
    expect(received).toContainEqual(
      expect.objectContaining({ type: 'assistant_message', payload: { text: 'live reply' } }),
    );
    expect(received).toContainEqual(
      expect.objectContaining({ type: 'transcript_refreshed', payload: { added: 1 } }),
    );

    unsubscribe();
    const internals = service as unknown as { transcriptWatchers?: Map<string, unknown> };
    expect(internals.transcriptWatchers?.size ?? 0).toBe(0);

    const countAfterUnsubscribe = received.length;
    appendFileSync(piPath, `${JSON.stringify(piMessage('assistant', 'after unsubscribe'))}\n`);
    bumpMtime(piPath);
    watcher.get(session.id)?.fire();

    expect(received.length).toBe(countAfterUnsubscribe);
  });

  it('catches up transcript lines appended while no subscriber exists on getEvents', async () => {
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi catch-up',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi catch-up',
    });
    expect(service.getEvents(session.id).map((event) => event.type)).toEqual(['user_message']);

    // Append with nobody subscribed and force a distinct mtime.
    appendFileSync(piPath, `${JSON.stringify(piMessage('assistant', 'offline reply'))}\n`);
    bumpMtime(piPath);

    const events = service.getEvents(session.id);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'assistant_message', payload: { text: 'offline reply' } }),
    );
  });

  it('refreshTranscript returns added:0 while the session is locally producing', async () => {
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi guard',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi guard',
    });
    service.getEvents(session.id);

    appendFileSync(piPath, `${JSON.stringify(piMessage('assistant', 'guarded reply'))}\n`);
    bumpMtime(piPath);

    const internals = service as unknown as { locallyProducing: Set<string> };
    internals.locallyProducing.add(session.id);
    try {
      expect(service.refreshTranscript(session.id)).toEqual({ added: 0 });
    } finally {
      internals.locallyProducing.delete(session.id);
    }

    expect(service.refreshTranscript(session.id).added).toBeGreaterThan(0);
  });
});

function piMessage(role: 'user' | 'assistant', text: string) {
  return {
    type: 'message',
    message: { role, content: [{ type: 'text', text }] },
  };
}

type MinimalWatcher = {
  close: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => MinimalWatcher;
};

type TranscriptWatchInternals = {
  createTranscriptWatcher: (id: string, path: string) => MinimalWatcher | null;
  transcriptWatchers?: Map<string, { poller?: ReturnType<typeof setInterval> }>;
  locallyProducing: Set<string>;
  refreshTranscriptIfNeeded: (session: unknown) => void;
  requireSession: (id: string) => unknown;
};

function installDeterministicTranscriptWatcher(service: SessionsService) {
  const internals = service as unknown as TranscriptWatchInternals;
  const handles = new Map<string, { fire: () => void; disablePolling: () => void; isClosed: () => boolean }>();

  internals.createTranscriptWatcher = (id: string) => {
    let closed = false;
    const watcher: MinimalWatcher = {
      close: () => {
        closed = true;
      },
      on: () => watcher,
    };
    handles.set(id, {
      // Kill the real 250ms interval poller so only the manual fire() below
      // drives refreshes — the wall-clock timer must not race the assertions.
      disablePolling: () => {
        const entry = internals.transcriptWatchers?.get(id);
        if (!entry?.poller) return;
        clearInterval(entry.poller);
        delete entry.poller;
      },
      fire: () => {
        if (closed || !internals.transcriptWatchers?.has(id) || internals.locallyProducing.has(id)) {
          return;
        }
        internals.refreshTranscriptIfNeeded(internals.requireSession(id));
      },
      isClosed: () => closed,
    });
    return watcher;
  };

  return handles;
}

function bumpMtime(path: string): void {
  const future = new Date(Date.now() + 1000);
  utimesSync(path, future, future);
}

async function waitFor(assertion: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}
