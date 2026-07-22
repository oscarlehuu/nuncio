import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';

const { Database } = require('bun:sqlite');
const [mode, dataDir, roleOrGate, gateOrStatement, maybeStatement] = process.argv.slice(2);
if (!mode || !dataDir || !roleOrGate || !gateOrStatement) {
  throw new Error('usage: <mode> <data-dir> <role-or-gate> <gate-or-statement> [statement]');
}
process.env.NUNCIO_DATA_DIR = dataDir;

function waitSync(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path) && Date.now() < deadline) Atomics.wait(signal, 0, 0, 5);
}

if (mode === 'race') {
  const role = roleOrGate;
  if (role !== 'a' && role !== 'b') throw new Error(`invalid child role: ${role}`);
  const gateDir = gateOrStatement;
  const ownMarker = join(gateDir, `${role}.columns-read`);
  const siblingMarker = join(gateDir, `${role === 'a' ? 'b' : 'a'}.columns-read`);
  const originalPrepare = Database.prototype.prepare;
  let synchronized = false;
  Database.prototype.prepare = function (sql: string, ...params: unknown[]) {
    const statement = originalPrepare.call(this, sql, ...params);
    if (!sql.includes('PRAGMA table_info(sessions)')) return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property === 'all') {
          return (...allParams: unknown[]) => {
            const rows = target.all(...allParams) as Array<{ name: string }>;
            if (!synchronized && !rows.some((column) => column.name === 'model_options')) {
              synchronized = true;
              writeFileSync(ownMarker, 'read');
              // Without a database-wide migration write lock, both children reach
              // this barrier with the same stale column snapshot. With the lock,
              // only its owner reaches it; the sibling rechecks after commit.
              waitSync(siblingMarker, 500);
            }
            return rows;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
} else if (mode === 'kill-after') {
  const gateDir = roleOrGate;
  const statement = maybeStatement ?? gateOrStatement;
  const originalExec = Database.prototype.exec;
  Database.prototype.exec = function (sql: string, ...params: unknown[]) {
    const result = originalExec.call(this, sql, ...params);
    if (sql.includes(statement)) {
      writeFileSync(join(gateDir, 'failpoint-hit'), statement);
      process.kill(process.pid, 'SIGKILL');
    }
    return result;
  };
} else {
  throw new Error(`unknown mode: ${mode}`);
}

const database = new DatabaseService();
database.onModuleDestroy();
console.log(JSON.stringify({ status: 'ok' }));
