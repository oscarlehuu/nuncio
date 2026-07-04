import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Session } from './api';
import { useSeenSessions } from './use-seen-sessions';

function makeSession(over: Partial<Session>): Session {
  return {
    id: 's1',
    title: 'T',
    status: 'IDLE',
    provider: 'pi',
    model: null,
    modelOptions: null,
    prompt: '',
    preview: null,
    workspace: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: true,
    createdAt: 0,
    updatedAt: 100,
    ...over,
  };
}

describe('useSeenSessions', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('treats a never-opened session as unread', () => {
    const { result } = renderHook(() => useSeenSessions());
    expect(result.current.isUnread(makeSession({ id: 'a', updatedAt: 5 }))).toBe(true);
  });

  it('marks a session read once opened at its current updatedAt', () => {
    const { result } = renderHook(() => useSeenSessions());
    const session = makeSession({ id: 'a', updatedAt: 50 });

    act(() => result.current.markSeen(session));
    expect(result.current.isUnread(session)).toBe(false);
  });

  it('goes unread again when the session advances past the watermark', () => {
    const { result } = renderHook(() => useSeenSessions());

    act(() => result.current.markSeen(makeSession({ id: 'a', updatedAt: 50 })));
    // Same session, later activity → past the mark.
    expect(result.current.isUnread(makeSession({ id: 'a', updatedAt: 80 }))).toBe(true);
  });

  it('persists the watermark across hook remounts (localStorage)', () => {
    const first = renderHook(() => useSeenSessions());
    act(() => first.result.current.markSeen(makeSession({ id: 'a', updatedAt: 50 })));

    const second = renderHook(() => useSeenSessions());
    expect(second.result.current.isUnread(makeSession({ id: 'a', updatedAt: 50 }))).toBe(false);
    expect(second.result.current.isUnread(makeSession({ id: 'a', updatedAt: 90 }))).toBe(true);
  });
});
