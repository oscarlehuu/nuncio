// CLI: extract one recorded Nuncio session into an eval task JSON.
//
//   bun run eval:extract -- --session <id> [--data-dir ~/.nuncio/data]
//     [--slug fix-slugify] [--base-sha <sha>] [--verify-command "bun test"]
//     [--timeout-ms 300000] [--dry-run]
//
// Reads the durable session row + event log straight from the SQLite store
// (read-only), pins the replay repo state to --base-sha (default: the repo's
// CURRENT HEAD — review it during curation), and writes eval/tasks/<slug>.json.
// Extraction is curation, not magic: read the generated JSON before committing.
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildTaskFromSession } from './lib/eval-extract.mjs';
import { tasksDir, validateTask } from './lib/eval-suite.mjs';

function parseArgs(argv) {
  const out = {
    session: null,
    dataDir: process.env.NUNCIO_DATA_DIR || join(homedir(), '.nuncio', 'data'),
    slug: undefined,
    baseSha: undefined,
    verifyCommand: undefined,
    timeoutMs: undefined,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => argv[(i += 1)];
    if (arg === '--session') out.session = take();
    else if (arg === '--data-dir') out.dataDir = take();
    else if (arg === '--slug') out.slug = take();
    else if (arg === '--base-sha') out.baseSha = take();
    else if (arg === '--verify-command') out.verifyCommand = take();
    else if (arg === '--timeout-ms') out.timeoutMs = Number(take());
    else if (arg === '--dry-run') out.dryRun = true;
  }
  return out;
}

function headSha(repo) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`could not resolve HEAD of ${repo}: ${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.session) {
    console.error('usage: bun run eval:extract -- --session <id> [--data-dir <dir>] [--slug <slug>] [--base-sha <sha>] [--verify-command <cmd>] [--dry-run]');
    process.exit(2);
  }
  const dbPath = join(resolve(args.dataDir), 'nuncio.db');
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath} (set --data-dir)`);

  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare('SELECT id, prompt, project_path, workspace, verify_owner FROM sessions WHERE id = ?')
      .get(args.session);
    if (!row) throw new Error(`session ${args.session} not found in ${dbPath}`);
    const events = db
      .prepare('SELECT type, payload FROM events WHERE session_id = ? ORDER BY seq ASC')
      .all(args.session)
      .map((event) => ({ type: event.type, payload: safeParse(event.payload) }));

    const session = {
      id: row.id,
      prompt: row.prompt,
      projectPath: row.project_path,
      workspace: row.workspace,
      verifyOwner: row.verify_owner,
    };
    const repo = session.projectPath ?? session.workspace;
    const task = buildTaskFromSession(session, events, {
      slug: args.slug,
      baseSha: args.baseSha ?? (repo ? headSha(repo) : undefined),
      verifyCommand: args.verifyCommand,
      timeoutMs: args.timeoutMs,
    });
    validateTask(task, `${task.id}.json`);

    if (args.dryRun) {
      console.log(JSON.stringify(task, null, 2));
      return;
    }
    await mkdir(tasksDir, { recursive: true });
    const file = join(tasksDir, `${task.id}.json`);
    if (existsSync(file)) throw new Error(`${file} already exists — pass --slug for a new id`);
    await writeFile(file, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
    console.log(`wrote ${file}`);
    console.log('Curate before committing: check prompt for secrets, confirm baseSha and verifyCommand.');
  } finally {
    db.close();
  }
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

await main();
