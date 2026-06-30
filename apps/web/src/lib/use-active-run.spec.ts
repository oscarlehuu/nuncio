import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useActiveRun } from './use-active-run';
import type { Session } from './api';

const fetchActiveRun = vi.fn();
const refreshSessionTranscript = vi.fn();

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    fetchActiveRun: (...args: unknown[]) => fetchActiveRun(...args),
    refreshSessionTranscript: (...args: unknown[]) => refreshSessionTranscript(...args),
  };
});

function cliSession(id = 's1'): Session {
  return {
    id,
    title: 'Handoff',
    status: 'IDLE',
    provider: 'cursor',
    model: null,
    modelOptions: null,
    prompt: 'task',
    preview: null,
    workspace: '/tmp/ws',
    projectPath: '/tmp/ws',
    baseBranch: null,
    worktreePath: null,
    branch: null,
    cursorBackend: 'cli',
    cursorChatId: 'chat-1',
    supportsInteraction: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('useActiveRun', () => {
  beforeEach(() => {
    fetchActiveRun.mockReset();
    refreshSessionTranscript.mockReset();
    refreshSessionTranscript.mockResolvedValue({ added: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for non-CLI sessions without polling', () => {
    const { result } = renderHook(() =>
      useActiveRun({ ...cliSession(), provider: 'pi', cursorBackend: null }),
    );
    expect(result.current).toBe(false);
    expect(fetchActiveRun).not.toHaveBeenCalled();
  });

  it('polls active-run and refreshes transcript for CLI handoff sessions', async () => {
    fetchActiveRun.mockResolvedValue({ active: true });
    const { result } = renderHook(() => useActiveRun(cliSession(), { pollMs: 50 }));
    await waitFor(() => expect(result.current).toBe(true));
    expect(fetchActiveRun).toHaveBeenCalledWith('s1');
    expect(refreshSessionTranscript).toHaveBeenCalledWith('s1');
  });

  it('refreshes transcript on every poll, not just on transitions', async () => {
    fetchActiveRun.mockResolvedValue({ active: false });
    renderHook(() => useActiveRun(cliSession(), { pollMs: 50 }));
    await waitFor(() => expect(refreshSessionTranscript).toHaveBeenCalledTimes(1));
    // After more polls, refresh should be called again
    await waitFor(() => expect(refreshSessionTranscript).toHaveBeenCalledTimes(2), { timeout: 3000 });
  });

  it('calls onTranscriptRefreshed when refresh appended new events', async () => {
    fetchActiveRun.mockResolvedValue({ active: false });
    refreshSessionTranscript
      .mockResolvedValueOnce({ added: 2 })
      .mockResolvedValue({ added: 0 });
    const onTranscriptRefreshed = vi.fn();
    renderHook(() => useActiveRun(cliSession(), { pollMs: 50, onTranscriptRefreshed }));
    await waitFor(() => expect(onTranscriptRefreshed).toHaveBeenCalledTimes(1));
  });

  it('does not call onTranscriptRefreshed when nothing was added', async () => {
    fetchActiveRun.mockResolvedValue({ active: false });
    refreshSessionTranscript.mockResolvedValue({ added: 0 });
    const onTranscriptRefreshed = vi.fn();
    renderHook(() => useActiveRun(cliSession(), { pollMs: 50, onTranscriptRefreshed }));
    await waitFor(() => expect(refreshSessionTranscript).toHaveBeenCalled());
    expect(onTranscriptRefreshed).not.toHaveBeenCalled();
  });
});
