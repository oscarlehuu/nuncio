import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  chatStoreMtime,
  readChatStoreModel,
  readCursorChatNames,
  readCursorChatName,
} from '../../../src/cursor-local/cursor-chat-store';

function createStateVscdb(dbPath: string, composers: Array<{ composerId: string; name: string }>) {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const { Database } = require('bun:sqlite');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  const value = JSON.stringify({ allComposers: composers.map((c) => ({ type: 'head', composerId: c.composerId, name: c.name })) });
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('composer.composerHeaders', value);
  db.close();
}

function createStoreDb(dbPath: string, systemPrompt: string) {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const { Database } = require('bun:sqlite');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  const blobId = 'root-blob-id';
  const stmt = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
  stmt.run(blobId, Buffer.from(JSON.stringify({ role: 'system', content: systemPrompt })));
  db.close();
}

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

describe('readChatStoreModel', () => {
  let home: string;
  const chatId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nuncio-chat-store-model-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('extracts model name from "powered by X" in system prompt', () => {
    const dbPath = join(home, '.cursor/chats', 'abc123', chatId, 'store.db');
    createStoreDb(dbPath, 'You are an AI coding assistant, powered by Composer. You operate in Cursor.');
    expect(readChatStoreModel(home, chatId)).toBe('Composer');
  });

  it('extracts Claude from system prompt', () => {
    const dbPath = join(home, '.cursor/chats', 'xyz789', chatId, 'store.db');
    createStoreDb(dbPath, 'You are powered by Claude. Follow instructions.');
    expect(readChatStoreModel(home, chatId)).toBe('Claude');
  });

  it('returns null when no system prompt blob found', () => {
    const dbPath = join(home, '.cursor/chats', 'abc123', chatId, 'store.db');
    mkdirSync(join(dbPath, '..'), { recursive: true });
    const { Database } = require('bun:sqlite');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run('1', JSON.stringify({ role: 'user', content: 'hello' }));
    db.close();
    expect(readChatStoreModel(home, chatId)).toBeNull();
  });

  it('returns null when chats root is missing', () => {
    expect(readChatStoreModel(home, chatId)).toBeNull();
  });

  it('returns null when "powered by" pattern is absent', () => {
    const dbPath = join(home, '.cursor/chats', 'abc', chatId, 'store.db');
    createStoreDb(dbPath, 'You are a coding assistant. Follow instructions.');
    expect(readChatStoreModel(home, chatId)).toBeNull();
  });
});

describe('readCursorChatNames', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nuncio-cursor-names-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns a Map of chatId → name from state.vscdb', () => {
    const dbPath = join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    createStateVscdb(dbPath, [
      { composerId: 'chat-1', name: 'Fix auth bug' },
      { composerId: 'chat-2', name: 'Agent chat SDK integration' },
    ]);
    const names = readCursorChatNames(home);
    expect(names.get('chat-1')).toBe('Fix auth bug');
    expect(names.get('chat-2')).toBe('Agent chat SDK integration');
  });

  it('returns empty Map when state.vscdb is missing', () => {
    expect(readCursorChatNames(home).size).toBe(0);
  });

  it('returns empty Map when composer.composerHeaders key is absent', () => {
    const dbPath = join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    mkdirSync(join(dbPath, '..'), { recursive: true });
    const { Database } = require('bun:sqlite');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    db.close();
    expect(readCursorChatNames(home).size).toBe(0);
  });
});

describe('readCursorChatName', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nuncio-cursor-name-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns the name for a specific chatId', () => {
    const dbPath = join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    createStateVscdb(dbPath, [
      { composerId: 'abc-123', name: 'My chat' },
    ]);
    expect(readCursorChatName(home, 'abc-123')).toBe('My chat');
  });

  it('returns null when chatId is not found', () => {
    const dbPath = join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    createStateVscdb(dbPath, [
      { composerId: 'other', name: 'Other chat' },
    ]);
    expect(readCursorChatName(home, 'abc-123')).toBeNull();
  });
});
