import { describe, it, expect } from 'vitest';
import type { SessionEvent } from './api';
import { buildTranscriptBlocks, derivePendingQueuedSteers } from './transcript-build-blocks';
import { IncrementalTranscriptBuilder } from './use-transcript-blocks';

let seq = 0;
function ev(type: string, payload: Record<string, unknown>): SessionEvent {
  seq += 1;
  return { seq, type, payload, createdAt: seq };
}

describe('steer queue + interrupt transcript blocks', () => {
  it('renders steer_queued as a queued user block', () => {
    const blocks = buildTranscriptBlocks([
      ev('user_message', { text: 'do the thing' }),
      ev('steer_queued', { text: 'also do this after' }),
    ]);

    const queued = blocks.find((b) => b.kind === 'user' && b.queued);
    expect(queued).toBeDefined();
    expect(queued?.kind === 'user' && queued.text).toBe('also do this after');
  });

  it('replaces the queued block when the same steer is delivered', () => {
    const blocks = buildTranscriptBlocks([
      ev('user_message', { text: 'do the thing' }),
      ev('steer_queued', { text: 'follow up' }),
      ev('assistant_message', { text: 'first turn done' }),
      ev('steer_message', { text: 'follow up' }),
    ]);

    const userBlocks = blocks.filter((b) => b.kind === 'user' && b.text === 'follow up');
    expect(userBlocks).toHaveLength(1);
    expect(userBlocks[0].kind === 'user' && userBlocks[0].queued).toBeFalsy();
  });

  it('renders an interrupted marker block', () => {
    const blocks = buildTranscriptBlocks([
      ev('user_message', { text: 'go' }),
      ev('assistant_delta', { delta: 'partial answ' }),
      ev('interrupted', {}),
    ]);

    expect(blocks.some((b) => b.kind === 'interrupted')).toBe(true);
    // The partial assistant text is preserved, not dropped.
    expect(blocks.some((b) => b.kind === 'assistant' && b.text.includes('partial answ'))).toBe(
      true,
    );
  });

  it('drops queued placeholders when the queue is cleared for multitasking', () => {
    const blocks = buildTranscriptBlocks([
      ev('user_message', { text: 'do the thing' }),
      ev('steer_queued', { text: 'follow up A' }),
      ev('steer_queued', { text: 'follow up B' }),
      ev('steer_queue_cleared', {}),
    ]);

    expect(blocks.some((b) => b.kind === 'user' && b.queued)).toBe(false);
    // The delivered original prompt is untouched.
    expect(blocks.filter((b) => b.kind === 'user')).toHaveLength(1);
  });
});

describe('derivePendingQueuedSteers', () => {
  it('lists queued steers not yet delivered', () => {
    const pending = derivePendingQueuedSteers([
      ev('user_message', { text: 'do the thing' }),
      ev('steer_queued', { text: 'follow up A' }),
      ev('steer_queued', { text: 'follow up B' }),
    ]);

    expect(pending.map((p) => p.text)).toEqual(['follow up A', 'follow up B']);
    expect(new Set(pending.map((p) => p.key)).size).toBe(2);
  });

  it('drops a queued steer once it is delivered sequentially', () => {
    const pending = derivePendingQueuedSteers([
      ev('steer_queued', { text: 'follow up A' }),
      ev('steer_queued', { text: 'follow up B' }),
      ev('steer_message', { text: 'follow up A' }),
    ]);

    expect(pending.map((p) => p.text)).toEqual(['follow up B']);
  });

  it('empties when the queue is cleared for multitasking', () => {
    const pending = derivePendingQueuedSteers([
      ev('steer_queued', { text: 'follow up A' }),
      ev('steer_queued', { text: 'follow up B' }),
      ev('steer_queue_cleared', {}),
    ]);

    expect(pending).toHaveLength(0);
  });
});

describe('stable block keys', () => {
  it('keeps the streaming assistant block key stable across deltas and final flush', () => {
    const builder = new IncrementalTranscriptBuilder();
    const events: SessionEvent[] = [
      ev('user_message', { text: 'stream please' }),
      ev('assistant_delta', { delta: 'hel' }),
    ];
    const first = builder.update([...events]);
    const streamingKey = first.find((b) => b.kind === 'assistant')?.key;
    expect(streamingKey).toBeTruthy();

    events.push(ev('assistant_delta', { delta: 'lo' }));
    const second = builder.update([...events]);
    expect(second.find((b) => b.kind === 'assistant')?.key).toBe(streamingKey);

    events.push(ev('assistant_message', { text: 'hello' }));
    const third = builder.update([...events]);
    expect(third.find((b) => b.kind === 'assistant')?.key).toBe(streamingKey);
  });

  it('gives distinct keys to distinct blocks', () => {
    const blocks = buildTranscriptBlocks([
      ev('user_message', { text: 'one' }),
      ev('assistant_message', { text: 'reply one' }),
      ev('user_message', { text: 'two' }),
      ev('assistant_message', { text: 'reply two' }),
      ev('tool_start', { callId: 'c1', tool: 'bash' }),
      ev('tool_end', { callId: 'c1', tool: 'bash' }),
    ]);

    const keys = blocks.map((b) => b.key);
    expect(keys.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
