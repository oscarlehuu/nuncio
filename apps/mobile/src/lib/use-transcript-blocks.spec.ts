// @vitest-environment jsdom

import { act, createElement } from 'react';
// @ts-expect-error Mobile ships react-dom for Expo web, but omits its browser-only type package.
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '@nuncio/core/api';
import { buildTranscriptBlocks, type TranscriptBlock } from '@nuncio/core/transcript-build-blocks';
import * as transcriptModule from './use-transcript-blocks';
import { useTranscriptBlocks } from './use-transcript-blocks';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type TestRoot = {
  render: (children: ReturnType<typeof createElement>) => void;
  unmount: () => void;
};

function event(seq: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return { seq, type, payload, createdAt: seq };
}

describe('useTranscriptBlocks', () => {
  let container: HTMLDivElement;
  let root: TestRoot;
  let latest: TranscriptBlock[] | undefined;

  function Harness({ events }: { events: SessionEvent[] }) {
    latest = useTranscriptBlocks(events);
    return null;
  }

  function render(events: SessionEvent[]): TranscriptBlock[] {
    act(() => root.render(createElement(Harness, { events })));
    return latest!;
  }

  beforeEach(() => {
    latest = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container) as TestRoot;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('processes an appended suffix without rebuilding finalized prefix blocks', () => {
    expect(render([])).toEqual([]);
    const prefix = [
      event(1, 'user_message', { text: 'first question' }),
      event(2, 'assistant_message', { text: 'first answer' }),
    ];
    const first = render(prefix);
    const extended = [
      ...prefix,
      event(3, 'user_message', { text: 'second question' }),
      event(4, 'assistant_message', { text: 'second answer' }),
    ];

    const second = render(extended);

    expect(second).toEqual(buildTranscriptBlocks(extended));
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('resets the hook-local builder for shrink, reorder, and session replacement', () => {
    const original = [
      event(1, 'user_message', { text: 'session A question 1' }),
      event(2, 'assistant_message', { text: 'session A answer 1' }),
      event(3, 'user_message', { text: 'session A question 2' }),
      event(4, 'assistant_message', { text: 'session A answer 2' }),
    ];
    render(original);

    const shrunk = original.slice(0, 2);
    expect(render(shrunk)).toEqual(buildTranscriptBlocks(shrunk));

    render(original);
    const reordered = [original[2]!, original[1]!, original[0]!, original[3]!];
    expect(render(reordered)).toEqual(buildTranscriptBlocks(reordered));

    const replacement = [
      event(1, 'user_message', { text: 'Phiên B 👋' }),
      event(2, 'assistant_message', { text: 'Trả lời B' }),
    ];
    const replacementBlocks = render(replacement);
    expect(replacementBlocks).toEqual(buildTranscriptBlocks(replacement));
    expect(replacementBlocks).not.toContainEqual(
      expect.objectContaining({ text: 'session A question 1' }),
    );
  });

  it('does not expose the core builder as a mobile hook export', () => {
    expect(transcriptModule).not.toHaveProperty('IncrementalTranscriptBuilder');
  });
});
