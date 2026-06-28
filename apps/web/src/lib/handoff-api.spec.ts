import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchLocalCursorSessions, handoffSession } from './handoff-api';

describe('handoff-api', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchLocalCursorSessions returns items from the API', async () => {
    const items = [
      {
        chatId: 'abc',
        workspace: '/code/nuncio',
        projectSlug: 'code-nuncio',
        title: 'Fix bug',
        preview: 'hello',
        updatedAt: 1,
        messageCount: 2,
        alreadyImported: false,
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items }),
      }),
    );

    const result = await fetchLocalCursorSessions('/code/nuncio');
    expect(result).toEqual(items);
    expect(fetch).toHaveBeenCalledWith('/api/cursor/local-sessions?workspace=%2Fcode%2Fnuncio');
  });

  it('handoffSession posts to the handoff endpoint', async () => {
    const session = { id: 'sess-1', title: 'Fix bug' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => session,
      }),
    );

    const result = await handoffSession({
      cursorChatId: 'abc',
      workspace: '/code/nuncio',
      title: 'Fix bug',
    });
    expect(result).toEqual(session);
    expect(fetch).toHaveBeenCalledWith('/api/sessions/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cursorChatId: 'abc',
        workspace: '/code/nuncio',
        title: 'Fix bug',
      }),
    });
  });

  it('throws HandoffApiError with mapped message when handoff fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'not found',
      }),
    );

    await expect(
      handoffSession({ cursorChatId: 'missing', workspace: '/code/nuncio' }),
    ).rejects.toMatchObject({
      name: 'HandoffApiError',
      status: 404,
      message: 'This Cursor chat no longer exists on your Mac.',
    });
  });
});
