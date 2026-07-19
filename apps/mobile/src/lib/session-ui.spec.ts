import { describe, expect, it } from 'vitest';
import { groupTranscriptBlocks, statusBadgeVariant, toolIconForVerb } from './session-ui';

describe('toolIconForVerb', () => {
  it.each([
    ['Read', 'file'],
    ['Grepped', 'search'],
    ['Ran', 'terminal'],
    ['Edited', 'pencil'],
    ['Wrote', 'pencil'],
    ['Fetched', 'globe'],
    ['Found', 'folder'],
    ['Listed', 'list'],
  ] as const)('maps %s to %s', (verb, icon) => {
    expect(toolIconForVerb(verb)).toBe(icon);
  });

  it('uses a neutral icon for unknown tools', () => {
    expect(toolIconForVerb('Used')).toBe('sparkles');
  });
});

describe('statusBadgeVariant', () => {
  it.each([
    ['CREATED', 'secondary'],
    ['RUNNING', 'default'],
    ['IDLE', 'secondary'],
    ['PAUSED', 'secondary'],
    ['ARCHIVED', 'outline'],
    ['ERROR', 'destructive'],
  ] as const)('maps %s to %s', (status, variant) => {
    expect(statusBadgeVariant(status)).toBe(variant);
  });
});

describe('groupTranscriptBlocks', () => {
  it('clusters consecutive tool blocks while preserving other transcript blocks', () => {
    const user = { kind: 'user', key: 'u', text: 'hello' } as const;
    const tool = (key: string) =>
      ({
        kind: 'tool',
        key,
        callId: key,
        tool: 'Read',
        status: 'done',
        summary: { verb: 'Read', subject: key },
      }) as const;

    const grouped = groupTranscriptBlocks([tool('a'), tool('b'), user, tool('c')]);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toMatchObject({ kind: 'tool-group', blocks: [tool('a'), tool('b')] });
    expect(grouped[1]).toBe(user);
    expect(grouped[2]).toMatchObject({ kind: 'tool-group', blocks: [tool('c')] });
  });

  it('deduplicates repeated block keys, keeping the latest block in transcript order', () => {
    const first = {
      kind: 'tool',
      key: 'tool-call_same',
      callId: 'same',
      tool: 'Read',
      status: 'running',
      summary: { verb: 'Read', subject: 'old.ts' },
    } as const;
    const latest = {
      ...first,
      status: 'done',
      summary: { verb: 'Read', subject: 'latest.ts' },
    } as const;
    const user = (text: string) => ({ kind: 'user', key: 'user_same', text }) as const;
    const other = {
      kind: 'tool',
      key: 'tool-call_other',
      callId: 'other',
      tool: 'Read',
      status: 'done',
      summary: { verb: 'Read', subject: 'other.ts' },
    } as const;

    const grouped = groupTranscriptBlocks([first, user('old'), latest, user('latest'), other]);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toMatchObject({ kind: 'tool-group', blocks: [latest] });
    expect(grouped[1]).toMatchObject({ kind: 'user', text: 'latest' });
    expect(grouped[2]).toMatchObject({ kind: 'tool-group', blocks: [other] });
    expect(grouped.map((block) => block.key)).toEqual([
      'tool-group-tool-call_same',
      'user_same',
      'tool-group-tool-call_other',
    ]);
  });
});
