import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import { CAPTURE_EVIDENCE_TOOL_NAME } from '../../../src/agents/pi-engine/capture-evidence-tool';
import { EvidenceCaptureService } from '../../../src/evidence/evidence-capture.service';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';

/**
 * Solo Nuncio Engine sessions carry the capture_evidence tool wired to the
 * provider-neutral EvidenceCaptureService: success appends evidence_captured
 * to the durable log; a missing service degrades to a tool error.
 */

type CreateAgentSessionOptions = Record<string, unknown>;
type ToolShape = {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

let createAgentSessionOptions: CreateAgentSessionOptions[] = [];

const makePiSdkStub = () => ({
  AuthStorage: { create: () => ({}) },
  SettingsManager: { create: () => ({}) },
  ModelRegistry: {
    create: () => ({
      getError: () => undefined,
      getAvailable: () => [],
      getProviderDisplayName: (provider: string) => provider,
      find: () => undefined,
    }),
  },
  SessionManager: {},
  DefaultResourceLoader: class {
    constructor(readonly options: Record<string, unknown>) {}
    async reload() {}
  },
  createAgentSession: (options: CreateAgentSessionOptions) => {
    createAgentSessionOptions.push(options);
    return {
      session: {
        sessionFile: '/tmp/fake-pi/session.jsonl',
        subscribe: () => () => {},
        prompt: async () => {},
      },
    };
  },
  getAgentDir: () => '/tmp/default-pi-agent',
  createReadTool: (cwd: string) => ({ name: 'read', cwd }),
  createBashTool: (cwd: string) => ({ name: 'bash', cwd }),
  createEditTool: (cwd: string) => ({ name: 'edit', cwd }),
  createWriteTool: (cwd: string) => ({ name: 'write', cwd }),
  createGrepTool: (cwd: string) => ({ name: 'grep', cwd }),
  createFindTool: (cwd: string) => ({ name: 'find', cwd }),
  createLsTool: (cwd: string) => ({ name: 'ls', cwd }),
});

function injectPiSdkStub(provider: PiAgentProvider): void {
  (provider as unknown as { piSdkPromise: Promise<unknown> }).piSdkPromise =
    Promise.resolve(makePiSdkStub());
}

function captureTool(): ToolShape {
  const options = createAgentSessionOptions.at(-1);
  if (!options) throw new Error('createAgentSession was not called');
  const tool = (options.customTools as ToolShape[]).find(
    (candidate) => candidate.name === CAPTURE_EVIDENCE_TOOL_NAME,
  );
  if (!tool) throw new Error('capture_evidence tool not wired');
  return tool;
}

class FakeEvidenceCaptureService {
  captureCalls: Array<{ sessionId: string; input: unknown }> = [];
  outcome: unknown = {
    afterRef: { id: 'media-9', mimeType: 'image/png' },
    route: '/dash',
    viewport: { w: 1440, h: 900 },
    workspaceHead: 'deadbeef',
  };

  async capture(session: { id: string }, input: unknown): Promise<unknown> {
    this.captureCalls.push({ sessionId: session.id, input });
    return this.outcome;
  }

  async captureKnown(): Promise<unknown> {
    return null;
  }
}

describe('PiAgentProvider capture_evidence wiring', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let evidence: FakeEvidenceCaptureService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-capture-wiring-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    evidence = new FakeEvidenceCaptureService();
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [
        PiAgentProvider,
        { provide: EvidenceCaptureService, useValue: evidence },
      ],
    }).compile();

    provider = module.get(PiAgentProvider);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.PI_AGENT_DIR;
  });

  beforeEach(() => {
    createAgentSessionOptions = [];
    evidence.captureCalls = [];
    process.env.PI_AGENT_DIR = '/tmp/custom-pi-agent';
    injectPiSdkStub(provider);
  });

  it('wires capture_evidence into solo sessions and appends evidence_captured on success', async () => {
    const created = sessions.create({ prompt: 'ui work', provider: 'pi' });
    await provider.run(created.id, created.prompt, {
      cwd: '/tmp/workspaces/evidence-session',
      emit: () => {},
    });

    const tool = captureTool();
    const result = await tool.execute('call-1', { url: 'http://localhost:5173/dash' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('/dash');
    expect(evidence.captureCalls).toEqual([
      {
        sessionId: created.id,
        input: { url: 'http://localhost:5173/dash', phase: 'after' },
      },
    ]);
    const captured = events.list(created.id).find((e) => e.type === 'evidence_captured');
    expect(captured).toBeDefined();
    expect(captured!.payload).toMatchObject({ route: '/dash', workspaceHead: 'deadbeef' });
  });

  it('degrades to a tool error when the evidence service is absent', async () => {
    const bare = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [PiAgentProvider],
    }).compile();
    try {
      const bareProvider = bare.get(PiAgentProvider);
      const bareSessions = bare.get(SessionsRepository);
      injectPiSdkStub(bareProvider);
      const created = bareSessions.create({ prompt: 'no evidence', provider: 'pi' });
      await bareProvider.run(created.id, created.prompt, {
        cwd: '/tmp/workspaces/no-evidence',
        emit: () => {},
      });

      const tool = captureTool();
      const result = await tool.execute('call-2', { url: 'http://localhost:5173' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('unavailable');
    } finally {
      await bare.close();
    }
  });
});
