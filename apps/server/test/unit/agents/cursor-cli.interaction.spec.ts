import { Test, TestingModule } from '@nestjs/testing';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorCliProvider } from '../../../src/agents/providers/cursor-cli.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';

const sampleQuestion = {
  id: 'q1',
  prompt: 'Which lane?',
  options: [{ id: 'a', label: 'Frontend', description: 'UI work' }],
};

function askQuestionStartedLine(callId: string): string {
  return JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    call_id: callId,
    tool_call: {
      askQuestionToolCall: {
        args: { title: 'Need your input', questions: [sampleQuestion] },
      },
    },
  });
}

function askQuestionCompletedLine(callId: string): string {
  return JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: callId,
    tool_call: {
      askQuestionToolCall: { result: { success: {} } },
    },
  });
}

describe('CursorCliProvider interaction', () => {
  let module: TestingModule;
  let provider: CursorCliProvider;
  let dataDir: string;
  let fakeAgentBin: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-cli-interaction-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    fakeAgentBin = join(tmpdir(), `nuncio-fake-agent-interaction-${Date.now()}`);
    writeFileSync(fakeAgentBin, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeAgentBin, 0o755);
    process.env.NUNCIO_CURSOR_AGENT_BIN = fakeAgentBin;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule, SessionsPersistenceModule],
      providers: [CursorCliProvider],
    }).compile();
    provider = module.get(CursorCliProvider);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakeAgentBin, { force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_CURSOR_AGENT_BIN;
  });

  it('supportsInteraction returns true', () => {
    expect(provider.supportsInteraction?.()).toBe(true);
  });

  it('interactive tool_end during steer does NOT emit user_input_resolved', async () => {
    const sessions = module.get(SessionsRepository);
    const events = module.get(EventsRepository);
    const session = sessions.createHandoff({
      title: 'Handoff',
      workspace: '/tmp/ws',
      cursorChatId: 'chat-1',
      prompt: 'Handoff',
    });
    const callId = 'call-aq-1';

    provider.runOverride = async (sessionId, _args, ctx) => {
      const handleStreamLine = (
        provider as unknown as {
          handleStreamLine: (id: string, line: string, context: typeof ctx) => void;
        }
      ).handleStreamLine.bind(provider);
      handleStreamLine(sessionId, askQuestionStartedLine(callId), ctx);
      handleStreamLine(sessionId, askQuestionCompletedLine(callId), ctx);
      return 0;
    };

    await provider.steer(session.id, 'go', {
      workspace: '/tmp/ws',
      cursorChatId: 'chat-1',
      transcriptMtimeMs: 0,
      emit: () => {},
    });

    const stored = events.list(session.id);
    expect(stored.some((e) => e.type === 'user_input_requested')).toBe(true);
    expect(stored.some((e) => e.type === 'user_input_resolved')).toBe(false);
  });

  it('submitInteraction emits resolved then steers with formatted answer', async () => {
    const sessions = module.get(SessionsRepository);
    const events = module.get(EventsRepository);
    const session = sessions.createHandoff({
      title: 'Handoff',
      workspace: '/tmp/ws',
      cursorChatId: 'chat-2',
      prompt: 'Handoff',
    });
    const callId = 'call-aq-2';

    events.append(session.id, 'user_input_requested', {
      requestId: callId,
      title: 'Need your input',
      questions: [sampleQuestion],
    });

    let steeredMessage: string | undefined;
    provider.runOverride = async (_sessionId, args, ctx) => {
      steeredMessage = args[args.length - 1];
      ctx.emit?.({ type: 'assistant_message', payload: { text: 'ok' } });
      return 0;
    };

    await provider.submitInteraction!(
      session.id,
      callId,
      {
        answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
        resolvedBy: 'user',
      },
      {
        workspace: '/tmp/ws',
        cursorChatId: 'chat-2',
        transcriptMtimeMs: 0,
        emit: () => {},
      },
    );

    const stored = events.list(session.id);
    const resolved = stored.find((e) => e.type === 'user_input_resolved');
    expect(resolved?.payload).toEqual({ requestId: callId, resolvedBy: 'user' });
    expect(steeredMessage).toBe('Frontend');
    expect(stored.some((e) => e.type === 'steer_message')).toBe(true);
  });

  it('submitInteraction rejects duplicate respond for the same requestId', async () => {
    const sessions = module.get(SessionsRepository);
    const events = module.get(EventsRepository);
    const session = sessions.createHandoff({
      title: 'Handoff',
      workspace: '/tmp/ws',
      cursorChatId: 'chat-3',
      prompt: 'Handoff',
    });

    events.append(session.id, 'user_input_requested', {
      requestId: 'tool_dup',
      questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }],
    });
    events.append(session.id, 'user_input_resolved', {
      requestId: 'tool_dup',
      resolvedBy: 'user',
    });

    provider.runOverride = async () => 0;

    await expect(
      provider.submitInteraction!(
        session.id,
        'tool_dup',
        { answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }], resolvedBy: 'user' },
        { workspace: '/tmp/ws', cursorChatId: 'chat-3', transcriptMtimeMs: 0 },
      ),
    ).rejects.toThrow(/No pending user input request/);
  });
});
