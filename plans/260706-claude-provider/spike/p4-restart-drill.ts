/**
 * Manual restart drill for the Claude provider (run with real auth):
 *
 *   NUNCIO_CLAUDE_INTEGRATION=1 bun plans/260706-claude-provider/spike/p4-restart-drill.ts
 *
 * Starts the nuncio server daemon against an ISOLATED tmp data dir (never the
 * default ~/.nuncio/data), creates a Claude session over the HTTP API, lets a
 * short turn complete, kills the daemon, restarts it against the SAME data dir,
 * steers the session, and verifies:
 *   - the reply retains context from before the restart (cwd-scoped resume), and
 *   - no duplicate events appear in the append-only event log (seq monotonic,
 *     the pre-restart turn's events are not replayed).
 *
 * It prints the observed event-log shape so the durability behavior is visible.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const SERVER_DIR = join(REPO_ROOT, 'apps/server');
const PORT = Number(process.env.NUNCIO_DRILL_PORT ?? 3987);
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = process.env.NUNCIO_CLAUDE_TEST_MODEL?.trim() || 'claude:haiku';

const dataDir = mkdtempSync(join(tmpdir(), 'nuncio-claude-restart-drill-'));
const workspace = join(dataDir, 'workspace');
mkdirSync(workspace);

// A throwaway git repo so `projectPath` (which lists branches) accepts the
// workspace — and so resume stays cwd-scoped to this dir, never the nuncio repo.
function initRepo(dir: string): void {
  const run = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'drill@nuncio.local']);
  run(['config', 'user.name', 'Nuncio Drill']);
  writeFileSync(join(dir, 'README.md'), '# restart drill workspace\n');
  run(['add', 'README.md']);
  run(['commit', '-m', 'init']);
}
initRepo(workspace);

// Guard: never run against the real data dir.
const defaultDataDir = join(homedir(), '.nuncio', 'data');
if (resolve(dataDir) === resolve(defaultDataDir)) {
  console.error('Refusing to run: data dir resolved to the default ~/.nuncio/data');
  process.exit(1);
}

function startDaemon(): ChildProcess {
  // Bypass run-server.mjs env-file resolution so no shared .env can redirect the
  // data dir; run main.ts directly with an explicit isolated environment.
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      NUNCIO_DATA_DIR: dataDir,
      NUNCIO_CURSOR_CWD: workspace,
      PORT: String(PORT),
    },
  });
  return child;
}

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error('server did not become healthy in time');
}

async function waitForIdle(id: string, timeoutMs = 120_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE}/api/sessions/${id}`);
    const body = (await res.json()) as { status: string };
    if (body.status === 'IDLE' || body.status === 'ERROR') return body.status;
    await sleep(150);
  }
  throw new Error(`session ${id} did not settle in time`);
}

async function listEvents(id: string): Promise<Array<{ seq: number; type: string; payload: unknown }>> {
  const res = await fetch(`${BASE}/api/sessions/${id}/events`);
  return (await res.json()) as Array<{ seq: number; type: string; payload: unknown }>;
}

function finalAssistantText(events: Array<{ type: string; payload: unknown }>): string {
  const message = events.filter((e) => e.type === 'assistant_message').at(-1);
  const payload = message?.payload as { text?: unknown } | undefined;
  return typeof payload?.text === 'string' ? payload.text : '';
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((res) => {
    child.once('exit', () => res());
    child.kill('SIGTERM');
    // Hard-kill fallback if it does not exit promptly.
    setTimeout(() => child.kill('SIGKILL'), 5_000);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`[drill] data dir: ${dataDir}`);
  console.log(`[drill] workspace: ${workspace}`);
  console.log(`[drill] port: ${PORT}`);

  // --- boot 1 ---
  let daemon = startDaemon();
  await waitForHealth();
  console.log('[drill] daemon up (boot 1)');

  const createRes = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'My favorite color is teal. Just acknowledge with: OK.',
      provider: 'claude',
      model: MODEL,
      projectPath: workspace,
    }),
  });
  if (createRes.status !== 201) {
    throw new Error(`session create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const created = (await createRes.json()) as { id: string; provider: string };
  console.log(`[drill] created session ${created.id} (provider=${created.provider})`);

  const status1 = await waitForIdle(created.id);
  console.log(`[drill] turn 1 settled: ${status1}`);
  const eventsBefore = await listEvents(created.id);
  const maxSeqBefore = Math.max(...eventsBefore.map((e) => e.seq));
  console.log(`[drill] event log after turn 1 (${eventsBefore.length} rows, max seq ${maxSeqBefore}):`);
  for (const e of eventsBefore) console.log(`  seq=${e.seq} type=${e.type}`);

  // --- kill + restart against the SAME data dir ---
  console.log('[drill] killing daemon...');
  await stop(daemon);
  await sleep(500);
  daemon = startDaemon();
  await waitForHealth();
  console.log('[drill] daemon up (boot 2, same data dir)');

  // The event log survives the restart with no duplication.
  const eventsAfterRestart = await listEvents(created.id);
  const dup = eventsAfterRestart.length !== eventsBefore.length;
  console.log(
    `[drill] event log after restart (before any steer): ${eventsAfterRestart.length} rows` +
      (dup ? ' — MISMATCH vs pre-restart!' : ' — unchanged (no duplication)'),
  );

  // --- steer after restart: resume must retain context ---
  const steerRes = await fetch(`${BASE}/api/sessions/${created.id}/steer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'What color did I say was my favorite? Answer in one word.' }),
  });
  if (steerRes.status !== 201) {
    throw new Error(`steer failed: ${steerRes.status} ${await steerRes.text()}`);
  }
  const status2 = await waitForIdle(created.id);
  console.log(`[drill] steer settled: ${status2}`);

  const eventsAfter = await listEvents(created.id);
  const reply = finalAssistantText(eventsAfter);
  const seqs = eventsAfter.map((e) => e.seq);
  const monotonic = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  const contextRetained = reply.toUpperCase().includes('TEAL');

  console.log(`[drill] event log after steer (${eventsAfter.length} rows):`);
  for (const e of eventsAfter) console.log(`  seq=${e.seq} type=${e.type}`);
  console.log(`[drill] final reply: ${JSON.stringify(reply)}`);
  console.log(`[drill] seq monotonic (no duplicates): ${monotonic}`);
  console.log(`[drill] context retained across restart: ${contextRetained}`);

  await stop(daemon);

  const ok = !dup && monotonic && contextRetained && status2 === 'IDLE';
  console.log(`[drill] RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('[drill] error:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });
