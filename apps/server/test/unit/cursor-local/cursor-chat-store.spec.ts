import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chatStoreMtime } from '../../../src/cursor-local/cursor-chat-store';

describe('chatStoreMtime', () => {
  let home: string;
  const chatId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nuncio-chat-store-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when chats root is missing', () => {
    expect(chatStoreMtime(home, chatId)).toBeNull();
  });

  it('returns store.db mtime when found under any hash dir', () => {
    const dbPath = join(home, '.cursor/chats', 'abc123', chatId, 'store.db');
    mkdirSync(join(dbPath, '..'), { recursive: true });
    writeFileSync(dbPath, 'sqlite');
    const now = Date.now() / 1000;
    utimesSync(dbPath, now, now);

    const mtime = chatStoreMtime(home, chatId);
    expect(mtime).not.toBeNull();
    expect(mtime!).toBeGreaterThan(0);
  });
});
