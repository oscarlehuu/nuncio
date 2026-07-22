import { Test, TestingModule } from '@nestjs/testing';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { PiLocalModule } from '../../../src/pi-local/pi-local.module';
import { PiLocalSessionsService } from '../../../src/pi-local/pi-local-sessions.service';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';
import { withSimulatedCursorProvider } from '../../helpers/simulated-cursor-app';

describe('SessionsService transcript file watcher', () => {
  let module: TestingModule;
  let service: SessionsService;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let piLocal: PiLocalSessionsService;
  let transcriptReads: number;
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
    events = module.get(EventsRepository);
    piLocal = module.get(PiLocalSessionsService);
    transcriptReads = 0;
    piLocal.openSession = (path: string) => {
      transcriptReads += 1;
      return {
        getEntries: () => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
        buildSessionContext: () => ({ model: null, thinkingLevel: null }),
      } as never;
    };
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

  it('checkpoints an empty transcript without repeated reads', () => {
    writeFileSync(piPath, '');
    const watcher = installDeterministicTranscriptWatcher(service);
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi empty transcript',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi empty transcript',
    });

    expect(service.getEvents(session.id)).toEqual([]);
    const unsubscribe = service.subscribe(session.id, () => undefined);
    const watchHandle = watcher.get(session.id);
    expect(watchHandle).toBeDefined();
    watchHandle?.disablePolling();
    const readsAfterSubscribe = transcriptReads;

    watchHandle?.fire();
    watchHandle?.fire();

    expect(transcriptReads).toBe(readsAfterSubscribe);
    unsubscribe();
  });

  it('reuses a successful-empty hydration checkpoint across get and getEvents', () => {
    writeFileSync(piPath, '');
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi repeated empty reads',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi repeated empty reads',
    });

    expect(service.get(session.id)).toMatchObject({ id: session.id });
    expect(service.get(session.id)).toMatchObject({ id: session.id });
    expect(service.getEvents(session.id)).toEqual([]);
    expect(service.getEvents(session.id)).toEqual([]);

    expect(transcriptReads).toBe(1);
  });

  it('retries a failed empty hydration before checkpointing the unchanged snapshot', () => {
    writeFileSync(piPath, '');
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi failed empty read',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi failed empty read',
    });
    const successfulOpenSession = piLocal.openSession;
    let failuresRemaining = 1;
    piLocal.openSession = (path: string) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        transcriptReads += 1;
        throw new Error('empty transcript temporarily unreadable');
      }
      return successfulOpenSession(path);
    };

    expect(service.get(session.id)).toMatchObject({ id: session.id });
    expect(service.getEvents(session.id)).toEqual([]);
    expect(service.get(session.id)).toMatchObject({ id: session.id });
    expect(service.getEvents(session.id)).toEqual([]);

    expect(transcriptReads).toBe(2);
  });

  it('re-reads a changed snapshot after successful-empty hydration and appends once', () => {
    writeFileSync(piPath, '');
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi empty then populated',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi empty then populated',
    });

    expect(service.get(session.id)).toMatchObject({ id: session.id });
    expect(transcriptReads).toBe(1);

    writeFileSync(piPath, `${JSON.stringify(piMessage('assistant', 'arrived later'))}\n`);
    bumpMtime(piPath);

    expect(service.get(session.id)).toMatchObject({ id: session.id });
    expect(service.getEvents(session.id)).toContainEqual(
      expect.objectContaining({ type: 'assistant_message', payload: { text: 'arrived later' } }),
    );
    expect(
      service.getEvents(session.id).filter((event) => event.type === 'assistant_message'),
    ).toHaveLength(1);
    expect(transcriptReads).toBe(2);
  });

  it('retries an unchanged snapshot through getEvents after a watcher read failure', () => {
    const watcher = installDeterministicTranscriptWatcher(service);
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi read retry',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi read retry',
    });
    service.getEvents(session.id);

    const unsubscribe = service.subscribe(session.id, () => undefined);
    const watchHandle = watcher.get(session.id);
    expect(watchHandle).toBeDefined();
    watchHandle?.disablePolling();
    appendFileSync(piPath, `${JSON.stringify(piMessage('assistant', 'recovered after read'))}\n`);
    bumpMtime(piPath);

    const successfulOpenSession = piLocal.openSession;
    let failuresRemaining = 1;
    piLocal.openSession = (path: string) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        transcriptReads += 1;
        throw new Error('transcript temporarily unreadable');
      }
      return successfulOpenSession(path);
    };
    const readsBeforeFailure = transcriptReads;

    watchHandle?.fire();
    expect(transcriptReads).toBe(readsBeforeFailure + 1);
    expect(events.list(session.id).some((event) => event.type === 'assistant_message')).toBe(false);
    expect(events.list(session.id).some((event) => event.type === 'transcript_refreshed')).toBe(false);

    const refreshed = service.getEvents(session.id);

    expect(transcriptReads).toBe(readsBeforeFailure + 2);
    expect(refreshed).toContainEqual(
      expect.objectContaining({
        type: 'assistant_message',
        payload: { text: 'recovered after read' },
      }),
    );
    expect(refreshed.filter((event) => event.type === 'transcript_refreshed')).toHaveLength(1);

    const readsAfterRecovery = transcriptReads;
    watchHandle?.fire();
    expect(transcriptReads).toBe(readsAfterRecovery);
    unsubscribe();
  });

  it('keeps retrying repeated watcher and getEvents read failures until one succeeds', () => {
    const watcher = installDeterministicTranscriptWatcher(service);
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi repeated read errors',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi repeated read errors',
    });
    service.getEvents(session.id);

    const unsubscribe = service.subscribe(session.id, () => undefined);
    const watchHandle = watcher.get(session.id);
    expect(watchHandle).toBeDefined();
    watchHandle?.disablePolling();
    appendFileSync(piPath, `${JSON.stringify(piMessage('assistant', 'eventual reply'))}\n`);
    bumpMtime(piPath);

    const successfulOpenSession = piLocal.openSession;
    let failuresRemaining = 3;
    piLocal.openSession = (path: string) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        transcriptReads += 1;
        throw new Error('transcript still unreadable');
      }
      return successfulOpenSession(path);
    };
    const readsBeforeFailures = transcriptReads;

    watchHandle?.fire();
    watchHandle?.fire();
    expect(service.getEvents(session.id).some((event) => event.type === 'assistant_message')).toBe(false);

    expect(transcriptReads).toBe(readsBeforeFailures + 3);
    expect(events.list(session.id).some((event) => event.type === 'transcript_refreshed')).toBe(false);

    watchHandle?.fire();

    expect(transcriptReads).toBe(readsBeforeFailures + 4);
    expect(events.list(session.id).filter((event) => event.type === 'assistant_message')).toContainEqual(
      expect.objectContaining({ payload: { text: 'eventual reply' } }),
    );
    expect(events.list(session.id).filter((event) => event.type === 'transcript_refreshed')).toHaveLength(1);

    const readsAfterSuccess = transcriptReads;
    watchHandle?.fire();
    expect(transcriptReads).toBe(readsAfterSuccess);
    unsubscribe();
  });

  it('does not re-read unchanged full transcript history on repeated poll refreshes', () => {
    const watcher = installDeterministicTranscriptWatcher(service);
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi unchanged poll',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi unchanged poll',
    });
    service.getEvents(session.id);

    const unsubscribe = service.subscribe(session.id, () => undefined);
    const watchHandle = watcher.get(session.id);
    expect(watchHandle).toBeDefined();
    watchHandle?.disablePolling();
    const readsAfterSubscribe = transcriptReads;

    watchHandle?.fire();
    watchHandle?.fire();
    watchHandle?.fire();

    expect(transcriptReads).toBe(readsAfterSubscribe);
    unsubscribe();
  });

  it('detects an append when coarse filesystem mtime stays unchanged', () => {
    const watcher = installDeterministicTranscriptWatcher(service);
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi coarse mtime',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi coarse mtime',
    });
    service.getEvents(session.id);
    const unchangedTimes = statSync(piPath);

    const unsubscribe = service.subscribe(session.id, () => undefined);
    const watchHandle = watcher.get(session.id);
    expect(watchHandle).toBeDefined();
    watchHandle?.disablePolling();

    appendFileSync(piPath, `${JSON.stringify(piMessage('assistant', 'same mtime reply'))}\n`);
    utimesSync(piPath, unchangedTimes.atime, unchangedTimes.mtime);
    watchHandle?.fire();

    expect(events.list(session.id)).toContainEqual(
      expect.objectContaining({ type: 'assistant_message', payload: { text: 'same mtime reply' } }),
    );
    unsubscribe();
  });

  it('detects same-mtime same-size transcript replacement by file identity', () => {
    const watcher = installDeterministicTranscriptWatcher(service);
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi inode replacement',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi inode replacement',
    });
    service.getEvents(session.id);
    const originalStat = statSync(piPath);
    const replacementPath = `${piPath}.replacement`;
    const replacement = `${JSON.stringify(piMessage('user', 'revised request'))}\n`;
    expect(Buffer.byteLength(replacement)).toBe(statSync(piPath).size);
    writeFileSync(replacementPath, replacement);
    utimesSync(replacementPath, originalStat.atime, originalStat.mtime);

    const unsubscribe = service.subscribe(session.id, () => undefined);
    const watchHandle = watcher.get(session.id);
    expect(watchHandle).toBeDefined();
    watchHandle?.disablePolling();

    renameSync(replacementPath, piPath);
    expect(statSync(piPath).ino).not.toBe(originalStat.ino);
    watchHandle?.fire();

    expect(events.list(session.id)).toContainEqual(
      expect.objectContaining({ type: 'user_message', payload: { text: 'revised request' } }),
    );
    unsubscribe();
  });

  it('checkpoints a changed transcript snapshot after successful zero-add dedupe', () => {
    const watcher = installDeterministicTranscriptWatcher(service);
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi zero add checkpoint',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi zero add checkpoint',
    });
    service.getEvents(session.id);

    const unsubscribe = service.subscribe(session.id, () => undefined);
    const watchHandle = watcher.get(session.id);
    expect(watchHandle).toBeDefined();
    watchHandle?.disablePolling();
    bumpMtime(piPath);
    const readsBeforeRefresh = transcriptReads;

    watchHandle?.fire();
    expect(transcriptReads).toBe(readsBeforeRefresh + 1);
    expect(events.list(session.id).filter((event) => event.type === 'transcript_refreshed')).toEqual([]);

    watchHandle?.fire();
    expect(transcriptReads).toBe(readsBeforeRefresh + 1);
    unsubscribe();
  });

  it('retries an unchanged transcript snapshot after append failure and recovers the event', () => {
    const watcher = installDeterministicTranscriptWatcher(service);
    const session = sessions.createHandoff({
      provider: 'pi',
      title: 'Pi append retry',
      workspace,
      providerThreadId: piPath,
      prompt: 'Pi append retry',
    });
    service.getEvents(session.id);

    const unsubscribe = service.subscribe(session.id, () => undefined);
    const watchHandle = watcher.get(session.id);
    expect(watchHandle).toBeDefined();
    watchHandle?.disablePolling();
    appendFileSync(piPath, `${JSON.stringify(piMessage('assistant', 'recovered reply'))}\n`);
    bumpMtime(piPath);

    const originalAppendBatch = events.appendBatch.bind(events);
    let appendBatchCalls = 0;
    events.appendBatch = ((sessionId, items) => {
      appendBatchCalls += 1;
      if (appendBatchCalls === 1) throw new Error('append temporarily unavailable');
      return originalAppendBatch(sessionId, items);
    }) as EventsRepository['appendBatch'];

    try {
      watchHandle?.fire();
      expect(appendBatchCalls).toBe(1);
      expect(events.list(session.id).some((event) => event.type === 'assistant_message')).toBe(false);
      expect(events.list(session.id).some((event) => event.type === 'transcript_refreshed')).toBe(false);

      const refreshed = service.getEvents(session.id);

      expect(appendBatchCalls).toBe(2);
      expect(refreshed).toContainEqual(
        expect.objectContaining({ type: 'assistant_message', payload: { text: 'recovered reply' } }),
      );
    } finally {
      events.appendBatch = originalAppendBatch as EventsRepository['appendBatch'];
      unsubscribe();
    }
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
  refreshTranscriptFromWatch: (id: string) => void;
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
        if (closed || !internals.transcriptWatchers?.has(id)) return;
        internals.refreshTranscriptFromWatch(id);
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
