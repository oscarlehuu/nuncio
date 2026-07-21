import { describe, expect, it } from 'vitest';
import type { SessionEvent } from './api';
import {
  buildTranscriptBlocks,
  derivePendingQueuedSteers,
  projectTaskDigest,
  workingIndicatorLabel,
  type TaskDigest,
} from './transcript-build-blocks';
import { parseInteractiveToolInput } from './interactive-tool-input';

function ev(seq: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return { seq, type, payload, createdAt: seq };
}

describe('parseInteractiveToolInput', () => {
  it('matches server fallback ids without colliding with explicit positional ids', () => {
    const parsed = parseInteractiveToolInput({
      questions: [
        {
          id: 'q2',
          prompt: 'First',
          options: [
            { id: '2', label: 'Alpha' },
            { label: 'Beta' },
          ],
        },
        { prompt: 'Second', options: [{ label: 'Gamma' }] },
      ],
    });

    expect(parsed?.questions.map((question) => question.id)).toEqual(['q2', 'q2-2']);
    expect(parsed?.questions[0]?.options.map((option) => option.id)).toEqual(['2', '2-2']);
  });
});

describe('buildTranscriptBlocks user preamble display', () => {
  it('hides ## Workspace preamble in the user bubble', () => {
    const composed = [
      '## Workspace',
      'branch: `main`',
      'base: `origin/dev`',
      '',
      '---',
      '',
      'what is your model',
    ].join('\n');
    const blocks = buildTranscriptBlocks([ev(1, 'user_message', { text: composed })]);
    const user = blocks.find((b) => b.kind === 'user');
    expect(user?.kind === 'user' && user.text).toBe('what is your model');
    expect(JSON.stringify(blocks)).not.toContain('## Workspace');
  });
});

describe('derivePendingQueuedSteers', () => {
  it('lists queued steers, drops delivered ones, and empties on clear', () => {
    expect(
      derivePendingQueuedSteers([
        ev(1, 'steer_queued', { text: 'A' }),
        ev(2, 'steer_queued', { text: 'B' }),
      ]).map((s) => s.text),
    ).toEqual(['A', 'B']);

    expect(
      derivePendingQueuedSteers([
        ev(1, 'steer_queued', { text: 'A' }),
        ev(2, 'steer_queued', { text: 'B' }),
        ev(3, 'steer_message', { text: 'A' }),
      ]).map((s) => s.text),
    ).toEqual(['B']);

    expect(
      derivePendingQueuedSteers([
        ev(1, 'steer_queued', { text: 'A' }),
        ev(2, 'steer_queue_cleared', {}),
      ]),
    ).toHaveLength(0);
  });

  it('steer_queue_cleared removes queued placeholder blocks from the transcript', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'do it' }),
      ev(2, 'steer_queued', { text: 'later' }),
      ev(3, 'steer_queue_cleared', {}),
    ]);
    expect(blocks.some((b) => b.kind === 'user' && b.queued)).toBe(false);
    expect(blocks.filter((b) => b.kind === 'user')).toHaveLength(1);
  });

  it('keeps steer_queued pending while the session is RUNNING', () => {
    const pending = derivePendingQueuedSteers([
      ev(1, 'user_message', { text: 'go' }),
      ev(2, 'status', { status: 'RUNNING' }),
      ev(3, 'assistant_delta', { delta: 'working…' }),
      ev(4, 'steer_queued', { text: 'follow up' }),
    ]);
    expect(pending.map((s) => s.text)).toEqual(['follow up']);
  });

  it('preserves FIFO order for multiple queued steers', () => {
    const pending = derivePendingQueuedSteers([
      ev(1, 'steer_queued', { text: 'first' }),
      ev(2, 'steer_queued', { text: 'second' }),
      ev(3, 'steer_queued', { text: 'third' }),
    ]);
    expect(pending.map((s) => s.text)).toEqual(['first', 'second', 'third']);
  });

  it('removes delivered steers in FIFO order as steer_message events land', () => {
    expect(
      derivePendingQueuedSteers([
        ev(1, 'steer_queued', { text: 'first' }),
        ev(2, 'steer_queued', { text: 'second' }),
        ev(3, 'steer_message', { text: 'first' }),
      ]).map((s) => s.text),
    ).toEqual(['second']);

    expect(
      derivePendingQueuedSteers([
        ev(1, 'steer_queued', { text: 'first' }),
        ev(2, 'steer_queued', { text: 'second' }),
        ev(3, 'steer_message', { text: 'first' }),
        ev(4, 'steer_message', { text: 'second' }),
      ]),
    ).toHaveLength(0);
  });
});

describe('buildTranscriptBlocks', () => {
  it('shows a live steer reservation immediately and keeps its position when accepted', () => {
    const reserved = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'start' }),
      ev(2, 'assistant_delta', { delta: 'working' }),
      ev(3, 'steer_reserved', { text: 'change direction' }),
    ]);

    expect(reserved.map((block) => block.kind)).toEqual(['user', 'assistant', 'user']);
    expect(reserved[2]).toMatchObject({
      kind: 'user',
      key: 'user-3',
      text: 'change direction',
    });

    const accepted = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'start' }),
      ev(2, 'assistant_delta', { delta: 'working' }),
      ev(3, 'steer_reserved', { text: 'change direction' }),
      ev(4, 'steer_message', { text: 'change direction' }),
    ]);
    expect(accepted.map((block) => block.kind)).toEqual(['user', 'assistant', 'user']);
    expect(accepted[2]).toMatchObject({
      kind: 'user',
      key: 'user-3',
      text: 'change direction',
    });
  });

  it('reconciles a rejected live reservation into one queued placeholder', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'start' }),
      ev(2, 'assistant_delta', { delta: 'working' }),
      ev(3, 'steer_reserved', { text: 'later' }),
      ev(4, 'steer_queued', { text: 'later' }),
    ]);

    const userBlocks = blocks.filter((block) => block.kind === 'user');
    expect(userBlocks).toHaveLength(2);
    expect(userBlocks[1]).toMatchObject({
      key: 'user-3',
      text: 'later',
      queued: true,
    });
  });

  it('hides a legacy Nuncio-augmented duplicate without hiding a genuine later turn', () => {
    const browserInstructions =
      'When the user asks for browser, web, UI, site, screenshot, or visual verification work, use the Nuncio browser tools first. Omit target to use the configured default from Settings > MCP & Tools; target=auto prefers the Nuncio in-app browser, then falls back to the Nuncio-owned external CDP browser.';
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'inspect the UI' }),
      ev(2, 'assistant_message', { text: 'done' }),
      ev(3, 'user_message', { text: `inspect the UI\n\n${browserInstructions}` }),
      ev(4, 'user_message', { text: 'a genuine later turn' }),
    ]);

    expect(blocks.filter((block) => block.kind === 'user')).toMatchObject([
      { text: 'inspect the UI' },
      { text: 'a genuine later turn' },
    ]);
    expect(blocks.some((block) => block.kind === 'user' && block.text.includes(browserInstructions))).toBe(false);
  });

  it('hides a server-projected transport duplicate even when its canonical row is outside the window', () => {
    const blocks = buildTranscriptBlocks([
      ev(439, 'user_message', { text: 'do ABC', transportDuplicateOfSeq: 2 }),
      ev(440, 'assistant_message', { text: 'done' }),
    ]);

    expect(blocks).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'done' }),
    ]);
  });

  it('keeps runtime-looking text when there is no earlier canonical user message', () => {
    const text = '## Current Nuncio runtime manifest (authoritative)\nThis is user-authored text.';
    const blocks = buildTranscriptBlocks([ev(1, 'user_message', { text })]);

    expect(blocks).toMatchObject([{ kind: 'user', text }]);
  });

  it('keeps a later user turn when the legacy browser paragraph is not the exact tail', () => {
    const browserInstructions =
      'When the user asks for browser, web, UI, site, screenshot, or visual verification work, use the Nuncio browser tools first. Omit target to use the configured default from Settings > MCP & Tools; target=auto prefers the Nuncio in-app browser, then falls back to the Nuncio-owned external CDP browser.';
    const later = `inspect the UI\n\n${browserInstructions}\n\nThis final paragraph is user-authored.`;
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'inspect the UI' }),
      ev(2, 'assistant_message', { text: 'done' }),
      ev(3, 'user_message', { text: later }),
    ]);

    expect(blocks.filter((block) => block.kind === 'user')).toMatchObject([
      { text: 'inspect the UI' },
      { text: later },
    ]);
  });

  it('pairs legacy tool_start and tool_end into one done block', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'tool_start', { tool: 'Read' }),
      ev(2, 'tool_end', { tool: 'Read', isError: false }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'tool', tool: 'Read', status: 'done' });
  });

  it('pairs tool events by callId', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'tool_start', { callId: 'c1', tool: 'bash', input: { cmd: 'ls' } }),
      ev(2, 'tool_end', { callId: 'c1', tool: 'bash', output: 'ok' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      callId: 'c1',
      status: 'done',
      input: { cmd: 'ls' },
      output: 'ok',
    });
  });

  it('drops a tool_end whose call was already closed (transcript-refresh re-append)', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'go' }),
      ev(2, 'tool_start', { callId: 'c1', tool: 'bash', input: { command: 'ls' } }),
      ev(3, 'tool_end', { callId: 'c1', tool: 'bash', output: 'a\nb' }),
      // A transcript refresh re-appends the same tool result with a plainer payload.
      ev(4, 'tool_end', { callId: 'c1', tool: 'bash', output: 'a\nb\n(more)' }),
    ]);
    expect(blocks.filter((b) => b.kind === 'tool')).toHaveLength(1);
  });

  it('drops a callId tool_end whose tool_start is outside the windowed event tail', () => {
    // Grid tiles subscribe to a bounded event window; a tool_end whose start
    // scrolled off must not render an orphan tool block that buries the chat.
    const blocks = buildTranscriptBlocks([
      ev(1, 'assistant_message', { text: 'working' }),
      ev(2, 'tool_end', { callId: 'started-earlier', tool: 'bash', output: 'x' }),
    ]);
    expect(blocks.filter((b) => b.kind === 'tool')).toHaveLength(0);
  });

  it('does not render a duplicate user bubble when a refresh re-hydrates the prompt', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: '[image 1] fix it', images: [{ mimeType: 'image/png', id: 'img-1' }] }),
      ev(2, 'assistant_message', { text: 'done' }),
      // Refresh re-appends the original prompt image-stripped.
      ev(3, 'user_message', { text: '[image 1] fix it' }),
    ]);
    const userBlocks = blocks.filter((b) => b.kind === 'user');
    expect(userBlocks).toHaveLength(1);
    // The first (richer) bubble is kept — with its image.
    expect(userBlocks[0].kind === 'user' && userBlocks[0].images).toHaveLength(1);
  });

  it('attaches a Cursor-style summary to each tool block', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'tool_start', { callId: 'c1', tool: 'read', input: { path: '/Users/me/x.ts' } }),
      ev(2, 'tool_end', { callId: 'c1', tool: 'read' }),
    ]);
    const tool = blocks[0];
    expect(tool.kind).toBe('tool');
    if (tool.kind === 'tool') {
      expect(tool.summary).toEqual({ verb: 'Read', subject: 'x.ts', context: undefined });
    }
  });

  it('summarizes bash commands', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'tool_start', { callId: 'c1', tool: 'bash', input: { cmd: 'pnpm test' } }),
    ]);
    const tool = blocks[0];
    expect(tool.kind).toBe('tool');
    if (tool.kind === 'tool') {
      expect(tool.summary.verb).toBe('Ran');
      expect(tool.summary.subject).toBe('pnpm test');
    }
  });

  it('renders Pi bash tool rows with command input and completion state', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'tool_start', {
        callId: 'pi-call',
        tool: 'bash',
        input: { command: 'bun test apps/web/src/lib/transcript-build-blocks.spec.ts' },
      }),
      ev(2, 'tool_end', {
        callId: 'pi-call',
        tool: 'bash',
        isError: false,
        output: 'passed',
      }),
    ]);
    expect(blocks).toHaveLength(1);
    const tool = blocks[0];
    expect(tool.kind).toBe('tool');
    if (tool.kind === 'tool') {
      expect(tool.status).toBe('done');
      expect(tool.input).toEqual({ command: 'bun test apps/web/src/lib/transcript-build-blocks.spec.ts' });
      expect(tool.output).toBe('passed');
      expect(tool.summary).toEqual({
        verb: 'Ran',
        subject: 'bun test apps/web/src/lib/transcript-build-blocks.spec.ts',
      });
    }
  });

  it('keeps live Pi thinking inline and does not split streamed answer text into trailing thinking', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'help' }),
      ev(2, 'thinking_start', { thinkingId: 'pi-think' }),
      ev(3, 'thinking_delta', { thinkingId: 'pi-think', delta: 'I should inspect first.' }),
      ev(4, 'thinking_message', { thinkingId: 'pi-think', text: 'I should inspect first.' }),
      ev(5, 'tool_start', { callId: 'pi-tool', tool: 'read', input: { path: 'src/main.ts' } }),
      ev(6, 'tool_end', { callId: 'pi-tool', tool: 'read', isError: false }),
      ev(7, 'assistant_delta', { delta: 'Here is the response.\n\nLet me think is a phrase in the answer.' }),
      ev(8, 'assistant_message', { text: 'Here is the response.\n\nLet me think is a phrase in the answer.' }),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['user', 'thinking', 'tool', 'assistant']);
    expect(blocks.filter((block) => block.kind === 'thinking')).toHaveLength(1);
    expect(blocks[1]).toMatchObject({ kind: 'thinking', thinkingId: 'pi-think' });
    expect(blocks[3]).toMatchObject({
      kind: 'assistant',
      text: 'Here is the response.\n\nLet me think is a phrase in the answer.',
    });
  });

  it('builds user_input block from requested + resolved events', () => {
    const questions = [{ id: 'q1', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] }];
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_input_requested', { requestId: 'r1', title: 'Title', questions }),
      ev(2, 'user_input_resolved', { requestId: 'r1', resolvedBy: 'user' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'user_input',
      requestId: 'r1',
      title: 'Title',
      questions,
      resolvedBy: 'user',
    });
  });

  it('builds a plan block from plan_updated', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'plan_updated', {
        items: [
          { id: 'a', text: 'Read the code', status: 'done' },
          { id: 'b', text: 'Write the fix', status: 'in_progress' },
        ],
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'plan',
      items: [
        { id: 'a', text: 'Read the code', status: 'done' },
        { id: 'b', text: 'Write the fix', status: 'in_progress' },
      ],
    });
  });

  it('builds a provider-neutral evidence block from evidence_captured', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'evidence_captured', {
        afterRef: { id: '0123456789abcdef0123456789abcdef', mimeType: 'image/png' },
        route: '/settings',
        viewport: { w: 1440, h: 900 },
        workspaceHead: 'deadbeef',
      }),
    ]);

    expect(blocks).toEqual([{
      kind: 'evidence',
      key: 'evidence-1',
      evidence: {
        afterRef: { id: '0123456789abcdef0123456789abcdef', mimeType: 'image/png' },
        route: '/settings',
        viewport: { w: 1440, h: 900 },
        workspaceHead: 'deadbeef',
      },
    }]);
  });

  it('folds before and after evidence and marks divergent workspace heads stale', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'evidence_captured', {
        beforeRef: { id: 'a'.repeat(32), mimeType: 'image/png' },
        route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'head-a',
      }),
      ev(2, 'evidence_captured', {
        afterRef: { id: 'b'.repeat(32), mimeType: 'image/png' },
        route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'head-b',
      }),
    ]);
    expect(blocks).toEqual([{
      kind: 'evidence', key: 'evidence-1', stale: true,
      evidence: {
        beforeRef: { id: 'a'.repeat(32), mimeType: 'image/png' },
        afterRef: { id: 'b'.repeat(32), mimeType: 'image/png' },
        route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'head-b',
      },
    }]);
  });

  it('folds same-head pairs without stale and keeps after-only evidence', () => {
    const paired = buildTranscriptBlocks([
      ev(1, 'evidence_captured', {
        beforeRef: { id: 'a'.repeat(32), mimeType: 'image/png' },
        route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'head-a',
      }),
      ev(2, 'evidence_captured', {
        afterRef: { id: 'b'.repeat(32), mimeType: 'image/png' },
        route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'head-a',
      }),
    ]);
    expect(paired).toHaveLength(1);
    expect(paired[0]).not.toHaveProperty('stale');
    expect(paired[0]).toMatchObject({ evidence: { beforeRef: {}, afterRef: {}, workspaceHead: 'head-a' } });

    const afterOnly = buildTranscriptBlocks([ev(3, 'evidence_captured', {
      afterRef: { id: 'c'.repeat(32), mimeType: 'image/png' },
      route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'head-c',
    })]);
    expect(afterOnly).toHaveLength(1);
    expect(afterOnly[0]).toMatchObject({ kind: 'evidence', key: 'evidence-3', evidence: { afterRef: {} } });
  });

  it('folds inline answers from user_input_resolved into the block', () => {
    const questions = [{ id: 'q1', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] }];
    const answers = [{ questionId: 'q1', selectedOptionIds: ['a'], freeText: 'note' }];
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_input_requested', { requestId: 'r1', questions }),
      ev(2, 'user_input_resolved', { requestId: 'r1', resolvedBy: 'user', answers }),
    ]);
    expect(blocks[0]).toMatchObject({
      kind: 'user_input',
      requestId: 'r1',
      resolvedBy: 'user',
      answers,
    });
  });

  it('builds user_input block from legacy tool_start askquestion + tool_end (not tool block)', () => {
    const questions = [{ id: 'q1', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] }];
    const blocks = buildTranscriptBlocks([
      ev(1, 'tool_start', {
        callId: 'c1',
        tool: 'askquestion',
        input: { title: 'Title', questions },
      }),
      ev(2, 'tool_end', { callId: 'c1', tool: 'askquestion', isError: false }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'user_input',
      requestId: 'c1',
      title: 'Title',
      questions,
      resolvedBy: 'user',
    });
    expect(blocks.some((b) => b.kind === 'tool')).toBe(false);
  });

  it('drops assistant messages that are only [REDACTED]', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'assistant_message', { text: '[REDACTED]' }),
      ev(2, 'assistant_message', { text: 'Real response' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'Real response' });
  });

  it('strips inline [REDACTED] from assistant text but keeps the rest', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'assistant_message', { text: 'Checking docs.\n\n[REDACTED]' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'Checking docs.' });
  });

  it('strips [REDACTED] appearing mid-text', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'assistant_message', { text: 'Before [REDACTED] after' }),
    ]);
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === 'assistant') {
      expect(blocks[0].text).toBe('Before  after');
    }
  });

  it('detects Cursor context messages and emits a cursor-context block', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', {
        text: 'Investigate CI failures\n<pr_shared_context>\nheadSha: abc\n</pr_shared_context>',
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('cursor-context');
    if (blocks[0].kind === 'cursor-context') {
      expect(blocks[0].summary).toMatch(/investigation/i);
      expect(blocks[0].sections).toHaveLength(1);
      expect(blocks[0].sections[0].tag).toBe('pr_shared_context');
    }
  });

  it('emits a plain user block for non-Cursor user messages', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'Hello agent' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('user');
  });

  it('emits a user block for steer_message events', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'steer_message', { text: 'Actually, do this instead' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'user', text: 'Actually, do this instead' });
  });

  it('surfaces disk-referenced and inline images on the user block', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', {
        text: 'look at this',
        images: [
          { mimeType: 'image/png', id: 'abc123' },
          { mimeType: 'image/jpeg', data: 'AAAA' },
        ],
      }),
    ]);
    expect(blocks[0]).toMatchObject({
      kind: 'user',
      text: 'look at this',
      images: [
        { mimeType: 'image/png', id: 'abc123' },
        { mimeType: 'image/jpeg', data: 'AAAA' },
      ],
    });
  });

  it('drops malformed image entries and omits images when none are valid', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'hi', images: [{ mimeType: 'image/png' }, 'nope', null] }),
    ]);
    expect(blocks[0]).toMatchObject({ kind: 'user', text: 'hi' });
    expect((blocks[0] as { images?: unknown }).images).toBeUndefined();
  });

  it('interleaves user, tool, and assistant content in order', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'hi' }),
      ev(2, 'tool_start', { callId: 'c1', tool: 'Read' }),
      ev(3, 'tool_end', { callId: 'c1', tool: 'Read' }),
      ev(4, 'assistant_delta', { delta: 'Hello' }),
      ev(5, 'assistant_message', { text: 'Hello' }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'tool', 'assistant']);
  });

  it('keeps thinking text out of assistant blocks', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'thinking_start', { thinkingId: 't1' }),
      ev(2, 'thinking_delta', { delta: 'hmm' }),
      ev(3, 'thinking_message', { text: 'hmm' }),
      ev(4, 'assistant_message', { text: 'Answer' }),
    ]);
    expect(blocks.some((b) => b.kind === 'thinking' && b.text === 'hmm')).toBe(true);
    expect(blocks.find((b) => b.kind === 'assistant')?.text).toBe('Answer');
  });

  it('deduplicates a hydrated assistant_message that repeats a delta-assembled message', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'assistant_delta', { delta: 'Hello ' }),
      ev(2, 'assistant_delta', { delta: 'world' }),
      ev(3, 'assistant_message', { text: 'Hello world' }),
      ev(4, 'assistant_message', { text: 'Hello world' }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'Hello world' });
  });

  it('deduplicates hydrated assistant_message even when the live full message had trailing whitespace', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'assistant_delta', { delta: 'Hello world\n' }),
      ev(2, 'assistant_message', { text: 'Hello world\n' }),
      ev(3, 'assistant_message', { text: 'Hello world' }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'Hello world' });
  });

  it('marks streaming assistant buffer at end', () => {
    const blocks = buildTranscriptBlocks([ev(1, 'assistant_delta', { delta: 'partial' })]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'partial', streaming: true });
  });

  it('leaves open tool as running', () => {
    const blocks = buildTranscriptBlocks([ev(1, 'tool_start', { callId: 'c1', tool: 'grep' })]);
    expect(blocks[0]).toMatchObject({ kind: 'tool', status: 'running' });
  });

  it('splits appended thinking into a separate thinking block (Cursor JSONL concatenates response + thinking)', () => {
    const text = 'Đúng vậy. ACP và SDK về cơ bản là cùng một mô hình.\n\nNói tóm lại: ACP không giải quyết được vấn đề handoff.\n\nThe user is asking a clarifying question about ACP vs SDK. Let me think about this carefully.';
    const blocks = buildTranscriptBlocks([ev(1, 'assistant_message', { text })]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('assistant');
    expect((blocks[0] as { text: string }).text).toBe(
      'Đúng vậy. ACP và SDK về cơ bản là cùng một mô hình.\n\nNói tóm lại: ACP không giải quyết được vấn đề handoff.',
    );
    expect(blocks[1].kind).toBe('thinking');
    expect((blocks[1] as { text: string }).text).toContain('The user is asking a clarifying question');
  });

  it('does not split thinking-like phrases that are part of the actual response', () => {
    const text = 'The user wants to implement ACP. This is a significant architectural decision.';
    const blocks = buildTranscriptBlocks([ev(1, 'assistant_message', { text })]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('assistant');
    expect((blocks[0] as { text: string }).text).toBe(text);
  });

  it('splits thinking starting with "Let me think" patterns', () => {
    const text = 'Here is the response.\n\nLet me think about this carefully and provide a good answer.';
    const blocks = buildTranscriptBlocks([ev(1, 'assistant_message', { text })]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('assistant');
    expect((blocks[0] as { text: string }).text).toBe('Here is the response.');
    expect(blocks[1].kind).toBe('thinking');
  });
  it('builds a verify_retry into a compact verify-retry block', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'verify_result', { command: 'bun test', ok: false }),
      ev(2, 'verify_retry', {
        round: 2,
        reason: 'verify_failed',
        command: 'bun test',
        outputTail: '1 failing',
        retryId: 'r-1',
      }),
    ]);
    expect(blocks).toContainEqual(
      expect.objectContaining({ kind: 'verify_retry', round: 2, command: 'bun test' }),
    );
  });

  it('builds a verify_needs_attention into a needs-attention block with reason and rounds', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'verify_needs_attention', {
        rounds: 3,
        reason: 'max_rounds',
        lastOutputTail: 'still red',
      }),
    ]);
    expect(blocks).toContainEqual(
      expect.objectContaining({
        kind: 'verify_needs_attention',
        rounds: 3,
        reason: 'max_rounds',
      }),
    );
  });

  it('keeps a stable key per verify row derived from event seq', () => {
    const blocks = buildTranscriptBlocks([
      ev(7, 'verify_retry', { round: 1, retryId: 'r-1' }),
      ev(9, 'verify_needs_attention', { rounds: 3, reason: 'repeated_failure' }),
    ]);
    const retry = blocks.find((b) => b.kind === 'verify_retry');
    const attention = blocks.find((b) => b.kind === 'verify_needs_attention');
    expect(retry?.key).toBe('verify-retry-7');
    expect(attention?.key).toBe('verify-attention-9');
  });
});

describe('workingIndicatorLabel', () => {
  it('reports writing when assistant is streaming', () => {
    const blocks = buildTranscriptBlocks([ev(1, 'assistant_delta', { delta: 'x' })]);
    expect(workingIndicatorLabel(blocks, true)).toBe('Nuncio is writing…');
  });

  it('reports tool name when a tool is running', () => {
    const blocks = buildTranscriptBlocks([ev(1, 'tool_start', { callId: 'c1', tool: 'Read' })]);
    expect(workingIndicatorLabel(blocks, true)).toBe('Nuncio is using Read…');
  });
});

describe('projectTaskDigest', () => {
  const cases: Array<{ name: string; payload: Record<string, unknown>; expected: TaskDigest }> = [
    {
      name: 'DONE with a passing verify and a branch',
      payload: {
        taskId: 't-abc',
        childSessionId: 's-child',
        status: 'DONE',
        outcomeSummary: 'Added the digest card and its tests.',
        verify: { passed: true, output: 'ok' },
        workspace: {
          branch: 'feat/digest-card',
          headSha: 'abc123',
          baseBranch: 'dev',
          dirtyFiles: [],
          diffStat: null,
        },
        childBranch: 'feat/digest-card',
      },
      expected: {
        taskId: 't-abc',
        childSessionId: 's-child',
        status: 'DONE',
        outcomeSummary: 'Added the digest card and its tests.',
        verify: { passed: true, output: 'ok' },
        childBranch: 'feat/digest-card',
      },
    },
    {
      name: 'FAILED with a failing verify and no summary',
      payload: {
        taskId: 't-def',
        childSessionId: 's-child2',
        status: 'FAILED',
        outcomeSummary: null,
        verify: { passed: false },
        workspace: null,
        childBranch: null,
      },
      expected: {
        taskId: 't-def',
        childSessionId: 's-child2',
        status: 'FAILED',
        outcomeSummary: null,
        verify: { passed: false },
        childBranch: null,
      },
    },
    {
      name: 'CANCELLED with no child session and no verify',
      payload: {
        taskId: 't-ghi',
        childSessionId: null,
        status: 'CANCELLED',
        outcomeSummary: null,
        verify: null,
        workspace: null,
        childBranch: null,
      },
      expected: {
        taskId: 't-ghi',
        childSessionId: null,
        status: 'CANCELLED',
        outcomeSummary: null,
        verify: null,
        childBranch: null,
      },
    },
  ];

  it.each(cases)('projects $name', ({ payload, expected }) => {
    expect(projectTaskDigest(payload)).toEqual(expected);
  });

  it('coerces an unknown status to FAILED and degrades malformed optional fields to null', () => {
    expect(projectTaskDigest({ taskId: 't1', status: 'WEIRD', verify: { passed: 'yes' } })).toEqual({
      taskId: 't1',
      childSessionId: null,
      status: 'FAILED',
      outcomeSummary: null,
      verify: null,
      childBranch: null,
    });
  });

  it('renders a task_completed event as a single digest block', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'delegate this' }),
      ev(2, 'task_completed', {
        taskId: 't-abc',
        childSessionId: 's-child',
        status: 'DONE',
        outcomeSummary: 'done',
        verify: { passed: true },
        childBranch: 'feat/x',
      }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].kind).toBe('task_completed');
    expect((blocks[1] as { digest: TaskDigest }).digest.childSessionId).toBe('s-child');
    expect(blocks[1].key).toBe('task-completed-2');
  });
});
