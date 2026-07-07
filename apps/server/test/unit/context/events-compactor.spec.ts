import { renderEventsSince } from '../../../src/context/events-compactor';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';

function ev(seq: number, type: string, payload: unknown): SessionEvent {
  return { seq, type, payload, createdAt: seq };
}

describe('renderEventsSince', () => {
  it('renders the header and included event kinds in order', () => {
    const events: SessionEvent[] = [
      ev(1, 'user_message', { text: 'fix the bug' }),
      ev(2, 'assistant_delta', { delta: 'ignored' }),
      ev(3, 'tool_start', { tool: 'Edit', input: { file_path: 'src/a.ts' } }),
      ev(4, 'assistant_message', { text: 'done, patched src/a.ts' }),
      ev(5, 'verify_result', { ok: true, outputTail: 'all green' }),
    ];
    const out = renderEventsSince(events, 4096, { sessionId: 's1', sinceSeq: 0 });
    expect(out).toContain('## Session s1 since seq 0 (compacted)');
    expect(out).toContain('**User:** fix the bug');
    expect(out).toContain('→ tool Edit(src/a.ts)');
    expect(out).toContain('**Assistant:** done, patched src/a.ts');
    expect(out).toContain('✔ verify passed');
    // Excluded content never appears.
    expect(out).not.toContain('ignored');
  });

  it('excludes delta/thinking/status/steer_queued/transcript_refreshed', () => {
    const events: SessionEvent[] = [
      ev(1, 'assistant_delta', { delta: 'a' }),
      ev(2, 'thinking_delta', { delta: 'b' }),
      ev(3, 'thinking_message', { text: 'c' }),
      ev(4, 'status', { status: 'RUNNING' }),
      ev(5, 'steer_queued', { text: 'd' }),
      ev(6, 'transcript_refreshed', { added: 1 }),
      ev(7, 'user_message', { text: 'keep me' }),
    ];
    const out = renderEventsSince(events, 4096, { sessionId: 's1', sinceSeq: 0 });
    expect(out).toContain('keep me');
    for (const noise of ['a', 'b', 'c', 'RUNNING', 'd']) {
      expect(out).not.toContain(`**Assistant:** ${noise}`);
    }
    expect(out.split('\n').filter((l) => l.startsWith('**') || l.startsWith('→') || l.startsWith('✔') || l.startsWith('✘'))).toHaveLength(1);
  });

  it('renders a failed verify with a truncated reason', () => {
    const out = renderEventsSince(
      [ev(1, 'verify_result', { ok: false, outputTail: 'x'.repeat(500) })],
      4096,
      { sessionId: 's1', sinceSeq: 0 },
    );
    expect(out).toContain('✘ verify failed:');
    // Reason capped ~200 bytes.
    const line = out.split('\n').find((l) => l.startsWith('✘'))!;
    expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(240);
  });

  it('renders an error event and a task_completed digest goal+status', () => {
    const events: SessionEvent[] = [
      ev(1, 'error', { message: 'provider crashed' }),
      ev(2, 'task_completed', { taskId: 't1', status: 'DONE', outcomeSummary: 'ok', childBranch: null, verify: null, workspace: null, childSessionId: 'c1' }),
    ];
    const out = renderEventsSince(events, 4096, { sessionId: 's1', sinceSeq: 0 });
    expect(out).toContain('provider crashed');
    expect(out.toLowerCase()).toContain('task');
    expect(out).toContain('DONE');
  });

  it('tail-truncates each assistant message to 512 bytes', () => {
    const out = renderEventsSince(
      [ev(1, 'assistant_message', { text: 'y'.repeat(2000) })],
      4096,
      { sessionId: 's1', sinceSeq: 0 },
    );
    const line = out.split('\n').find((l) => l.startsWith('**Assistant:**'))!;
    // '**Assistant:** ' prefix + <=512 bytes of text.
    expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(15 + 512);
  });

  it('evicts oldest lines first under budget and adds a dropped marker', () => {
    const events: SessionEvent[] = Array.from({ length: 30 }, (_, i) =>
      ev(i + 1, 'user_message', { text: `message number ${i} ${'z'.repeat(100)}` }),
    );
    const out = renderEventsSince(events, 512, { sessionId: 's1', sinceSeq: 0 });
    expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(512);
    expect(out).toMatch(/_\(\d+ earlier events dropped\)_/);
    // Newest survives, oldest dropped.
    expect(out).toContain('message number 29');
    expect(out).not.toContain('message number 0 ');
  });

  it('returns header only for an empty slice, with no dropped marker', () => {
    const out = renderEventsSince([], 4096, { sessionId: 's1', sinceSeq: 7 });
    expect(out.trim()).toBe('## Session s1 since seq 7 (compacted)');
    expect(out).not.toContain('dropped');
  });

  it('does not throw on malformed payloads', () => {
    const events: SessionEvent[] = [
      ev(1, 'user_message', null),
      ev(2, 'tool_start', { tool: 42 }),
      ev(3, 'assistant_message', {}),
      ev(4, 'verify_result', {}),
    ];
    expect(() => renderEventsSince(events, 4096, { sessionId: 's1', sinceSeq: 0 })).not.toThrow();
  });
});
