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

/** Find the store.db path for a chatId (scans all hash dirs). */
function findChatStoreDb(homeDir: string, chatId: string): string | null {
  const root = join(homeDir, '.cursor/chats');
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dbPath = join(root, entry.name, chatId, 'store.db');
    if (existsSync(dbPath)) return dbPath;
  }
  return null;
}

/**
 * Reads chat names from Cursor's global state.vscdb.
 * The key `composer.composerHeaders` contains a JSON array of all composer sessions
 * with their `composerId` and `name` fields.
 *
 * Returns a Map<chatId, name> for O(1) lookup.
 */
export function readCursorChatNames(homeDir: string): Map<string, string> {
  const dbPath = join(homeDir, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  if (!existsSync(dbPath)) return new Map();

  try {
    const { Database } = require('bun:sqlite');
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'").get() as { value: string } | undefined;
    db.close();

    if (!row?.value) return new Map();
    const parsed = JSON.parse(row.value) as { allComposers?: Array<{ composerId?: string; name?: string }> };
    const names = new Map<string, string>();
    for (const composer of parsed.allComposers ?? []) {
      if (composer.composerId && composer.name) {
        names.set(composer.composerId, composer.name);
      }
    }
    return names;
  } catch {
    return new Map();
  }
}

/** Convenience: get a single chat name by chatId. */
export function readCursorChatName(homeDir: string, chatId: string): string | null {
  return readCursorChatNames(homeDir).get(chatId) ?? null;
}

interface ComposerBranch {
  branchName: string;
  lastInteractionAt: number;
}

interface ComposerRepo {
  repoPath: string;
  branches: ComposerBranch[];
}

interface ComposerMetadata {
  name?: string;
  branch?: string;
  repoPath?: string;
  contextUsagePercent?: number;
}

/**
 * Reads metadata for a Cursor chat from state.vscdb composer headers:
 * chat name, most recently used git branch, repo path, and context usage %.
 */
export function readCursorChatMetadata(homeDir: string, chatId: string): ComposerMetadata {
  const dbPath = join(homeDir, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  if (!existsSync(dbPath)) return {};

  try {
    const { Database } = require('bun:sqlite');
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'").get() as { value: string } | undefined;
    db.close();

    if (!row?.value) return {};
    const parsed = JSON.parse(row.value) as {
      allComposers?: Array<{
        composerId?: string;
        name?: string;
        contextUsagePercent?: number;
        trackedGitRepos?: ComposerRepo[];
      }>;
    };

    const composer = parsed.allComposers?.find((c) => c.composerId === chatId);
    if (!composer) return {};

    const meta: ComposerMetadata = {
      name: composer.name,
      contextUsagePercent: composer.contextUsagePercent,
    };

    // Find the most recently used branch across all tracked repos
    const repos = composer.trackedGitRepos ?? [];
    let bestBranch: ComposerBranch | null = null;
    let bestRepo = '';
    for (const repo of repos) {
      for (const b of repo.branches ?? []) {
        if (!bestBranch || b.lastInteractionAt > bestBranch.lastInteractionAt) {
          bestBranch = b;
          bestRepo = repo.repoPath;
        }
      }
    }
    if (bestBranch) {
      meta.branch = bestBranch.branchName;
      meta.repoPath = bestRepo;
    }

    return meta;
  } catch {
    return {};
  }
}

/**
 * Best-effort model name extraction from the Cursor chat store.db.
 * The system prompt blob contains "powered by X" (e.g. "Composer", "Claude").
 * Returns the model name or null if not found.
 */
export function readChatStoreModel(homeDir: string, chatId: string): string | null {
  const dbPath = findChatStoreDb(homeDir, chatId);
  if (!dbPath) return null;

  try {
    // Use require to avoid bun:sqlite type issues in tsc
    const { Database } = require('bun:sqlite');
    const db = new Database(dbPath, { readonly: true });
    const blobs = db.query('SELECT data FROM blobs').all() as Array<{ data: Buffer }>;
    db.close();

    for (const blob of blobs) {
      const text = new TextDecoder().decode(blob.data as Uint8Array);
      if (!text.includes('"role":"system"')) continue;
      // Parse the JSON to get the content
      try {
        const parsed = JSON.parse(text) as { role?: string; content?: string };
        if (parsed.role !== 'system' || !parsed.content) continue;
        // Extract "powered by X" from the system prompt
        const match = parsed.content.match(/powered by ([A-Za-z]+)/i);
        if (match?.[1]) return match[1];
      } catch {
        continue;
      }
    }
  } catch {
    // store.db may not be a valid SQLite db or may be locked
  }
  return null;
}
