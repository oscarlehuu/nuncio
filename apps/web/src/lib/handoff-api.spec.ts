import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchLocalCursorSessions,
  fetchLocalPiSessions,
  fetchAllLocalSessions,
  handoffSession,
} from './handoff-api';

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

  it('fetchLocalPiSessions returns items from the API', async () => {
    const items = [
      {
        sessionId: 'pi-1',
        path: '/path/to/pi-session',
        workspace: '/code/nuncio',
        title: 'Fix DB',
        preview: 'sqlite work',
        updatedAt: 2,
        messageCount: 4,
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

    const result = await fetchLocalPiSessions('/code/nuncio');
    expect(result).toEqual(items);
    expect(fetch).toHaveBeenCalledWith('/api/pi/local-sessions?workspace=%2Fcode%2Fnuncio');
  });

  it('fetchAllLocalSessions aggregates, maps, and sorts Cursor and Pi sessions', async () => {
    const cursorItems = [
      {
        chatId: 'cursor-1',
        workspace: '/code/nuncio',
        projectSlug: 'code-nuncio',
        title: 'Fix login',
        preview: 'auth',
        updatedAt: 1000,
        messageCount: 2,
        alreadyImported: false,
      },
    ];
    const piItems = [
      {
        sessionId: 'pi-1',
        path: '/path/to/pi-session',
        workspace: '/code/nuncio',
        title: 'Fix DB',
        preview: 'sqlite',
        updatedAt: 2000,
        messageCount: 4,
        alreadyImported: false,
      },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/api/cursor/local-sessions')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: cursorItems }),
          });
        }
        if (url.includes('/api/pi/local-sessions')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: piItems }),
          });
        }
        return Promise.reject(new Error('Unknown url'));
      }),
    );

    const result = await fetchAllLocalSessions('/code/nuncio');
    expect(result).toHaveLength(2);
    // Verified sorting by updatedAt descending (Pi session is 2000, Cursor is 1000)
    expect(result[0]).toEqual({
      source: 'pi',
      key: 'pi:/path/to/pi-session',
      title: 'Fix DB',
      preview: 'sqlite',
      updatedAt: 2000,
      messageCount: 4,
      alreadyImported: false,
      workspace: '/code/nuncio',
      piSessionPath: '/path/to/pi-session',
    });
    expect(result[1]).toEqual({
      source: 'cursor',
      key: 'cursor:cursor-1',
      title: 'Fix login',
      preview: 'auth',
      updatedAt: 1000,
      messageCount: 2,
      alreadyImported: false,
      workspace: '/code/nuncio',
      cursorChatId: 'cursor-1',
    });
  });

  it('handoffSession posts to the handoff endpoint with Cursor target', async () => {
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

  it('handoffSession posts to the handoff endpoint with Pi target', async () => {
    const session = { id: 'sess-2', title: 'Fix DB' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => session,
      }),
    );

    const result = await handoffSession({
      piSessionPath: '/path/to/pi-session',
      workspace: '/code/nuncio',
      title: 'Fix DB',
    });
    expect(result).toEqual(session);
    expect(fetch).toHaveBeenCalledWith('/api/sessions/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        piSessionPath: '/path/to/pi-session',
        workspace: '/code/nuncio',
        title: 'Fix DB',
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
