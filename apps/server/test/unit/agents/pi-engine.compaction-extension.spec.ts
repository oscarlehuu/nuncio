import { describe, expect, it } from 'bun:test';
import {
  buildCompactionHandler,
  isDegenerateSummary,
  renderVerbatimUserMessages,
  type CompactionHandlerDeps,
  type SessionBeforeCompactEventLike,
} from '../../../src/agents/pi-engine/compaction-extension';

/**
 * The Nuncio compaction policy on Pi's session_before_compact seam
 * (plans/260719-engine-shell-and-compaction, phase 05). Pi keeps the machinery
 * (trigger, cut point, session-file write + reload); this handler owns WHAT
 * SURVIVES: pinned state verbatim, recent user instructions verbatim, a
 * cheap-model narrative of the remainder, and a durable-history pointer.
 * Every failure path returns undefined → Pi's default compaction runs.
 */

function userMessage(text: string): unknown {
  return { role: 'user', content: text, timestamp: 1 };
}

function assistantMessage(text: string): unknown {
  return { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' };
}

function makeEvent(overrides: Partial<SessionBeforeCompactEventLike> = {}): SessionBeforeCompactEventLike {
  return {
    type: 'session_before_compact',
    reason: 'threshold',
    willRetry: false,
    preparation: {
      firstKeptEntryId: 'entry-42',
      tokensBefore: 90_000,
      isSplitTurn: false,
      messagesToSummarize: [
        userMessage('fix the steer composer bug'),
        assistantMessage('I looked at use-session-stream and found the reset.'),
        userMessage('also keep the draft on reconnect'),
      ],
      turnPrefixMessages: [],
      previousSummary: undefined,
      fileOps: { read: new Set(['a.ts']), written: new Set(), edited: new Set(['b.ts']) },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CompactionHandlerDeps> = {}): CompactionHandlerDeps {
  return {
    enabled: () => true,
    buildSurvivors: () => '## Pinned session state\nPlan:\n- [~] implement the module',
    summarize: async () => 'The session investigated the steer composer reset and traced it to the relay resubscribe.',
    transcriptPointer: 'Full history survives in the durable log; use read_session_history to re-read compacted turns.',
    ...overrides,
  };
}

describe('renderVerbatimUserMessages', () => {
  it('keeps user messages newest-first within the budget, rendered oldest-first', () => {
    const rendered = renderVerbatimUserMessages(
      [userMessage('first ask'), assistantMessage('noise'), userMessage('second ask')],
      10_000,
    );
    expect(rendered).toContain('## Recent user instructions (verbatim)');
    expect(rendered.indexOf('first ask')).toBeLessThan(rendered.indexOf('second ask'));
  });

  it('drops the oldest messages first when over budget', () => {
    const rendered = renderVerbatimUserMessages(
      [userMessage(`old ${'x'.repeat(300)}`), userMessage('newest instruction')],
      120,
    );
    expect(rendered).toContain('newest instruction');
    expect(rendered).not.toContain('old x');
  });

  it('extracts text from block-form user content and skips non-user roles', () => {
    const rendered = renderVerbatimUserMessages(
      [
        { role: 'user', content: [{ type: 'text', text: 'block form ask' }, { type: 'image' }] },
        assistantMessage('never'),
      ],
      10_000,
    );
    expect(rendered).toContain('block form ask');
    expect(rendered).not.toContain('never');
  });

  it('returns empty for no user messages', () => {
    expect(renderVerbatimUserMessages([assistantMessage('only')], 1000)).toBe('');
  });
});

describe('isDegenerateSummary', () => {
  it('flags empty, whitespace, and trivially short output', () => {
    expect(isDegenerateSummary('')).toBe(true);
    expect(isDegenerateSummary('   \n ')).toBe(true);
    expect(isDegenerateSummary('ok.')).toBe(true);
  });

  it('flags single-character runs and accepts real prose', () => {
    expect(isDegenerateSummary('a'.repeat(200))).toBe(true);
    expect(
      isDegenerateSummary('The session traced the composer reset to the relay resubscribe path.'),
    ).toBe(false);
  });
});

describe('buildCompactionHandler', () => {
  it('assembles survivors, verbatim instructions, narrative, file ops, and pointer in order', async () => {
    const handler = buildCompactionHandler(makeDeps());
    const result = await handler(makeEvent());

    expect(result?.compaction).toBeDefined();
    const summary = result!.compaction!.summary;
    const order = [
      '## Pinned session state',
      '## Recent user instructions (verbatim)',
      'relay resubscribe',
      'Files edited: b.ts',
      'read_session_history',
    ].map((marker) => summary.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(result!.compaction!.firstKeptEntryId).toBe('entry-42');
    expect(result!.compaction!.tokensBefore).toBe(90_000);
  });

  it('passes the previous summary and abort signal through to the summarizer', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const handler = buildCompactionHandler(makeDeps({
      summarize: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return 'A perfectly reasonable narrative continuation summary.';
      },
    }));
    const signal = new AbortController().signal;
    await handler(makeEvent({
      signal,
      preparation: {
        ...makeEvent().preparation,
        previousSummary: 'earlier progress summary',
        isSplitTurn: true,
        turnPrefixMessages: [assistantMessage('prefix work')],
      },
    }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.previousSummary).toBe('earlier progress summary');
    expect(calls[0]!.signal).toBe(signal);
    // Split-turn prefixes are folded into the same narrative input.
    expect((calls[0]!.messages as unknown[]).length).toBe(4);
  });

  it('stays disabled without touching the summarizer when the toggle is off', async () => {
    let summarizeCalls = 0;
    const handler = buildCompactionHandler(makeDeps({
      enabled: () => false,
      summarize: async () => {
        summarizeCalls += 1;
        return 'unused';
      },
    }));
    expect(await handler(makeEvent())).toBeUndefined();
    expect(summarizeCalls).toBe(0);
  });

  it('fails open when the summarizer throws', async () => {
    const handler = buildCompactionHandler(makeDeps({
      summarize: async () => {
        throw new Error('model unavailable');
      },
    }));
    expect(await handler(makeEvent())).toBeUndefined();
  });

  it('retries a degenerate summary once, then fails open', async () => {
    let calls = 0;
    const degenerate = buildCompactionHandler(makeDeps({
      summarize: async () => {
        calls += 1;
        return '!!';
      },
    }));
    expect(await degenerate(makeEvent())).toBeUndefined();
    expect(calls).toBe(2);

    let recoveredCalls = 0;
    const recovers = buildCompactionHandler(makeDeps({
      summarize: async () => {
        recoveredCalls += 1;
        return recoveredCalls === 1 ? '' : 'Second attempt produced a usable narrative summary.';
      },
    }));
    const result = await recovers(makeEvent());
    expect(recoveredCalls).toBe(2);
    expect(result?.compaction?.summary).toContain('usable narrative summary');
  });

  it('fails open when survivors building throws', async () => {
    const handler = buildCompactionHandler(makeDeps({
      buildSurvivors: () => {
        throw new Error('event log unavailable');
      },
    }));
    expect(await handler(makeEvent())).toBeUndefined();
  });

  it('fails open on a preparation without a kept-entry id', async () => {
    const handler = buildCompactionHandler(makeDeps());
    const event = makeEvent();
    (event.preparation as { firstKeptEntryId?: string }).firstKeptEntryId = '';
    expect(await handler(event)).toBeUndefined();
  });

  it('still produces a compaction when there are no survivors and no user messages', async () => {
    const handler = buildCompactionHandler(makeDeps({ buildSurvivors: () => '' }));
    const result = await handler(makeEvent({
      preparation: {
        ...makeEvent().preparation,
        messagesToSummarize: [assistantMessage('assistant-only history')],
      },
    }));
    expect(result?.compaction?.summary).toContain('relay resubscribe');
    expect(result!.compaction!.summary).not.toContain('## Pinned session state');
  });
});
