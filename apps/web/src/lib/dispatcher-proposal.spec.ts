import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItemDto } from './api';
import {
  dispatcherDone,
  dispatcherPayload,
  markDispatcherProposalApproved,
  queuedTasksLabel,
  selectTonightDispatcherProposal,
} from './dispatcher-proposal';

function item(partial: Partial<AttentionItemDto> & { payload?: Record<string, unknown> | null }): AttentionItemDto {
  return {
    id: partial.id ?? 'proposal-1',
    kind: partial.kind ?? 'dispatcher-proposal',
    subjectId: partial.subjectId ?? 'tonight',
    projectPath: partial.projectPath ?? '/repos/nuncio',
    severity: partial.severity ?? 2,
    title: partial.title ?? 'Tonight',
    payload: partial.payload === undefined
      ? { proposals: [{ title: 'Ship it', projectPath: '/repos/nuncio', rationale: 'Why' }] }
      : partial.payload,
    status: partial.status ?? 'open',
    acknowledgedAt: partial.acknowledgedAt ?? null,
    createdAt: partial.createdAt ?? 10,
    updatedAt: partial.updatedAt ?? 10,
    resolvedAt: partial.resolvedAt ?? null,
  };
}

describe('dispatcherPayload', () => {
  it('keeps well-formed proposals and drops malformed entries', () => {
    const payload = dispatcherPayload(item({
      payload: {
        proposals: [
          { title: 'Keep', projectPath: '/a', rationale: 'because' },
          { title: 12, projectPath: '/b' },
          null,
          'nope',
          { projectPath: '/missing-title' },
          { title: 'Partial' },
        ],
        approvedAt: 'not-a-number',
        taskIds: ['t1', 2, null, 't2'],
      },
    }));

    expect(payload).toEqual({
      proposals: [
        { title: 'Keep', projectPath: '/a', rationale: 'because' },
        { title: 'Partial', projectPath: null, rationale: '' },
      ],
      approvedAt: null,
      taskIds: ['t1', 't2'],
    });
  });

  it('returns empty proposals when the payload is missing or not an array', () => {
    expect(dispatcherPayload(item({ payload: null }))).toEqual({
      proposals: [],
      approvedAt: null,
      taskIds: [],
    });
    expect(dispatcherPayload(item({ payload: { proposals: { title: 'x' } } }))).toEqual({
      proposals: [],
      approvedAt: null,
      taskIds: [],
    });
  });
});

describe('dispatcherDone / queuedTasksLabel', () => {
  it('treats approvedAt or queued taskIds as done', () => {
    expect(dispatcherDone({ proposals: [], approvedAt: 1, taskIds: [] })).toBe(true);
    expect(dispatcherDone({ proposals: [], approvedAt: null, taskIds: ['t1'] })).toBe(true);
    expect(dispatcherDone({ proposals: [], approvedAt: null, taskIds: [] })).toBe(false);
  });

  it('pluralizes the queued-tasks label', () => {
    expect(queuedTasksLabel(1)).toBe('1 task queued');
    expect(queuedTasksLabel(0)).toBe('0 tasks queued');
    expect(queuedTasksLabel(3)).toBe('3 tasks queued');
  });
});

describe('selectTonightDispatcherProposal', () => {
  it('prefers the newest actionable draft over an older approved-open fallback', () => {
    const approved = item({
      id: 'old-approved',
      createdAt: 5,
      updatedAt: 5,
      payload: {
        proposals: [{ title: 'Old', projectPath: null, rationale: '' }],
        approvedAt: 1,
        taskIds: ['t-old'],
      },
    });
    const actionable = item({
      id: 'new-open',
      createdAt: 20,
      updatedAt: 20,
      payload: {
        proposals: [{ title: 'New', projectPath: null, rationale: '' }],
      },
    });

    expect(selectTonightDispatcherProposal([approved, actionable])?.id).toBe('new-open');
  });

  it('falls back to the newest approved-open proposal when nothing actionable remains', () => {
    const older = item({
      id: 'older',
      createdAt: 1,
      updatedAt: 1,
      payload: {
        proposals: [{ title: 'Older', projectPath: null, rationale: '' }],
        approvedAt: 1,
        taskIds: ['a'],
      },
    });
    const newer = item({
      id: 'newer',
      createdAt: 2,
      updatedAt: 2,
      payload: {
        proposals: [{ title: 'Newer', projectPath: null, rationale: '' }],
        approvedAt: 2,
        taskIds: ['b'],
      },
    });

    expect(selectTonightDispatcherProposal([older, newer])?.id).toBe('newer');
  });

  it('breaks ties with updatedAt then id, and ignores empty or non-proposal rows', () => {
    const a = item({
      id: 'a',
      createdAt: 10,
      updatedAt: 11,
      payload: { proposals: [{ title: 'A', projectPath: null, rationale: '' }] },
    });
    const b = item({
      id: 'b',
      createdAt: 10,
      updatedAt: 12,
      payload: { proposals: [{ title: 'B', projectPath: null, rationale: '' }] },
    });
    const empty = item({
      id: 'empty',
      createdAt: 99,
      payload: { proposals: [] },
    });
    const otherKind = item({
      id: 'other',
      kind: 'pr-review',
      createdAt: 100,
      payload: { proposals: [{ title: 'Nope', projectPath: null, rationale: '' }] },
    });
    const resolved = item({
      id: 'resolved',
      status: 'resolved',
      createdAt: 101,
      payload: { proposals: [{ title: 'Done', projectPath: null, rationale: '' }] },
    });

    expect(selectTonightDispatcherProposal([a, b, empty, otherKind, resolved])?.id).toBe('b');

    const tieA = item({
      id: 'tie-a',
      createdAt: 10,
      updatedAt: 10,
      payload: { proposals: [{ title: 'A', projectPath: null, rationale: '' }] },
    });
    const tieB = item({
      id: 'tie-b',
      createdAt: 10,
      updatedAt: 10,
      payload: { proposals: [{ title: 'B', projectPath: null, rationale: '' }] },
    });
    expect(selectTonightDispatcherProposal([tieA, tieB])?.id).toBe('tie-b');
  });

  it('returns null when no open dispatcher proposals carry work', () => {
    expect(selectTonightDispatcherProposal([])).toBeNull();
    expect(selectTonightDispatcherProposal([
      item({ status: 'resolved' }),
      item({ kind: 'permission' }),
      item({ payload: { proposals: [] } }),
    ])).toBeNull();
  });
});

describe('markDispatcherProposalApproved', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T13:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps approvedAt and taskIds without dropping prior payload fields', () => {
    const source = item({
      payload: {
        proposals: [{ title: 'Ship', projectPath: '/r', rationale: 'go' }],
        note: 'keep-me',
      },
    });

    expect(markDispatcherProposalApproved(source, ['task-1', 'task-2'])).toEqual({
      ...source,
      payload: {
        proposals: [{ title: 'Ship', projectPath: '/r', rationale: 'go' }],
        note: 'keep-me',
        approvedAt: Date.parse('2026-07-23T13:00:00.000Z'),
        taskIds: ['task-1', 'task-2'],
      },
    });
  });
});
