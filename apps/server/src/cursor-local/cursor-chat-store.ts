import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Scan ~/.cursor/chats/<hash>/<chatId>/store.db — hash algorithm is opaque, so walk all hashes. */
export function chatStoreMtime(homeDir: string, chatId: string): number | null {
  const root = join(homeDir, '.cursor/chats');
  if (!existsSync(root)) return null;

  let newest: number | null = null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dbPath = join(root, entry.name, chatId, 'store.db');
    if (!existsSync(dbPath)) continue;
    const mtime = statSync(dbPath).mtimeMs;
    if (newest == null || mtime > newest) newest = mtime;
  }
  return newest;
}
