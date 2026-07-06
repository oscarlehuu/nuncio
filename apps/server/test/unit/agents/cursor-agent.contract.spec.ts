import { beforeAll, afterAll, beforeEach, describe } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorAgentProvider } from '../../../src/agents/providers/cursor-agent.provider';
import type { CursorSdk } from '../../../src/agents/providers/cursor-agent.helpers';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { describeAgentProviderContract } from './provider-contract.suite';

type CursorScript = {
  deltas: string[];
  finalText: string;
  status: 'finished' | 'error' | 'cancelled';
};

/**
 * Scriptable @cursor/sdk stub. `send({ onDelta })` streams text-delta updates
 * (mapped to assistant_delta), and `run.wait()` returns the terminal result —
 * `result.result` is the authoritative final text the contract asserts against.
 */
function makeStubSdk(getScript: () => CursorScript): CursorSdk {
  const agent = {
    agentId: 'stub-agent-contract',
    send: async (
      _text: string,
      options?: { onDelta?: (args: { update: { type: string; text?: string } }) => void },
    ) => {
      const script = getScript();
      for (const delta of script.deltas) {
        options?.onDelta?.({ update: { type: 'text-delta', text: delta } });
      }
      return {
        id: 'stub-run-contract',
        wait: async () => ({
          id: 'stub-run-contract',
          status: script.status,
          result: script.finalText,
          durationMs: 1,
        }),
      };
    },
    close: () => undefined,
  };
  return {
    Agent: { create: async () => agent },
    Cursor: { models: { list: async () => [{ id: 'composer-2' }] } },
    CursorAgentError: class CursorAgentError extends Error {},
    JsonlLocalAgentStore: class JsonlLocalAgentStore {
      constructor(public dir: string) {}
    },
  } as unknown as CursorSdk;
}

describe('CursorAgentProvider contract', () => {
  let module: TestingModule;
  let provider: CursorAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;
  let previousKey: string | undefined;
  let script: CursorScript;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-cursor-contract-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    previousKey = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = 'cursor_contract_key';

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [CursorAgentProvider],
    }).compile();

    provider = module.get(CursorAgentProvider);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    provider.sdkOverride = makeStubSdk(() => script);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previousKey;
  });

  beforeEach(() => {
    script = { deltas: [], finalText: '', status: 'finished' };
    provider.bustCache();
  });

  describeAgentProviderContract('cursor', () => ({
    provider,
    sessions,
    events,
    runContext: { workspace: '/tmp/project', model: 'cursor:composer-2' },
    createSession: (prompt) =>
      sessions.create({ prompt, provider: 'cursor', model: 'cursor:composer-2' }),
    successDeltas: ['Cursor ', 'stream 世界'],
    // Distinct from the delta concat on purpose: Cursor's terminal message is
    // the SDK's authoritative `result.result`, not the joined token stream.
    successFinalText: 'Cursor authoritative result',
    arrangeSuccess: (deltas, finalText) => {
      script = { deltas, finalText, status: 'finished' };
    },
    arrangeError: () => {
      script = { deltas: [], finalText: '', status: 'error' };
    },
    // Cursor declares interrupt off — no interrupt() method surfaces it.
    exercisesInterrupt: false,
  }));
});
