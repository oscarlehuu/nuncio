/**
 * Read-only key/value lookups from VS Code-style `ItemTable` SQLite databases
 * (Cursor's state.vscdb). Defensive: returns {} on any failure.
 */

interface ReadonlyStatement {
  get: (...params: ReadonlyArray<unknown>) => unknown;
}

interface ReadonlyDatabase {
  query?: (sql: string) => ReadonlyStatement;
  prepare?: (sql: string) => ReadonlyStatement;
  close: () => unknown;
}

function openReadOnlyDatabase(dbPath: string): ReadonlyDatabase {
  // bun:sqlite is a Bun builtin — require keeps tsc happy without bun-types.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require('bun:sqlite') as {
    Database: new (path: string, options: { readonly: boolean }) => ReadonlyDatabase;
  };
  return new Database(dbPath, { readonly: true });
}

function coerceCell(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8');
  }
  return undefined;
}

export function readItemTableValues(input: {
  dbPath: string;
  keys: ReadonlyArray<string>;
}): Record<string, string> {
  const result: Record<string, string> = {};
  let database: ReadonlyDatabase | null = null;
  try {
    database = openReadOnlyDatabase(input.dbPath);
    const sql = 'SELECT value FROM ItemTable WHERE key = ?';
    const statement = database.query?.(sql) ?? database.prepare?.(sql);
    if (!statement) {
      return result;
    }
    for (const key of input.keys) {
      const row = statement.get(key) as { value?: unknown } | null | undefined;
      const value = coerceCell(row?.value);
      if (value !== undefined) {
        result[key] = value;
      }
    }
  } catch {
    return result;
  } finally {
    try {
      database?.close();
    } catch {
      // ignore close failures
    }
  }
  return result;
}
