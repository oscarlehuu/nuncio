// Live end-to-end sanity for the Phase 1 ClaudeAgentProvider against the REAL
// Claude Agent SDK (haiku, /tmp workspace). Not part of the committed test suite
// — it needs a logged-in Claude CLI and makes a real model call. Run with:
//   bun run apps/server/test/../../plans/260706-claude-provider/spike/p1-provider-live.ts
// Wires the real repositories via the server's DI module (temp SQLite under a
// throwaway NUNCIO_DATA_DIR), runs one prompt, and asserts the contract:
// deltas stream, an authoritative assistant_message lands, the SDK session_id is
// persisted as providerThreadId, and dispose() reaps the CLI subprocess (S9).
import { Test } from '@nestjs/testing';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClaudeAgentProvider } from '../../../apps/server/src/agents/providers/claude-agent.provider';
import { DatabaseModule } from '../../../apps/server/src/db/database.module';
import { EventsRepository } from '../../../apps/server/src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../apps/server/src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../apps/server/src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../apps/server/src/settings/settings.module';

/**
 * Count `claude` CLI subprocesses under THIS bun process's subtree. Anchoring on
 * our own PID excludes the ambient Claude Code desktop app / Codex processes on
 * the dev box, so the count reflects only the subprocess our provider spawned —
 * the one dispose() must reap (S9).
 */
function ownClaudeChildCount(): number {
  try {
    const descendants = new Set<number>();
    const walk = (pid: number): void => {
      const children = execSync(`pgrep -P ${pid} || true`, { encoding: 'utf8' })
        .split('\n')
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((n) => Number.isInteger(n));
      for (const child of children) {
        if (descendants.has(child)) continue;
        descendants.add(child);
        walk(child);
      }
    };
    walk(process.pid);
    let count = 0;
    for (const pid of descendants) {
      const command = execSync(`ps -o command= -p ${pid} || true`, { encoding: 'utf8' });
      if (/\/claude(\s|$)/.test(command)) count += 1;
    }
    return count;
  } catch {
    return -1;
  }
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'nuncio-claude-live-'));
  const workspace = mkdtempSync(join(tmpdir(), 'nuncio-claude-ws-'));
  mkdirSync(workspace, { recursive: true });
  process.env.NUNCIO_DATA_DIR = dataDir;

  const module = await Test.createTestingModule({
    imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
    providers: [ClaudeAgentProvider],
  }).compile();

  const sessions = module.get(SessionsRepository);
  const events = module.get(EventsRepository);
  const provider = module.get(ClaudeAgentProvider);

  const available = await provider.isAvailable();
  console.log('[live] isAvailable:', available);
  if (!available) {
    console.log('[live] SKIP — no logged-in Claude CLI / ANTHROPIC_API_KEY. Nothing to validate live.');
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    return;
  }

  const created = sessions.create({ prompt: 'x', provider: 'claude', model: 'claude:haiku', workspace });
  let deltaCount = 0;
  await provider.run(created.id, 'Reply with exactly the word: PONG', {
    cwd: workspace,
    model: 'claude:haiku',
    emit: (event) => {
      if (event.type === 'assistant_delta') deltaCount += 1;
    },
  });

  const persisted = events.list(created.id);
  const assistantMessage = persisted.findLast((event) => event.type === 'assistant_message');
  const threadId = sessions.findById(created.id)?.providerThreadId;

  console.log('[live] status:', sessions.findById(created.id)?.status);
  console.log('[live] delta events (emitted):', deltaCount);
  console.log('[live] assistant_message:', JSON.stringify((assistantMessage?.payload as { text?: string })?.text));
  console.log('[live] providerThreadId persisted:', threadId);
  console.log('[live] canResumeThread:', provider.canResumeThread(sessions.findById(created.id)!));

  const before = ownClaudeChildCount();
  provider.dispose(created.id);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const after = ownClaudeChildCount();
  console.log(`[live] own claude CLI subprocesses — before dispose: ${before}, after+3s: ${after}`);

  const ok =
    sessions.findById(created.id)?.status === 'IDLE' &&
    deltaCount > 0 &&
    Boolean((assistantMessage?.payload as { text?: string })?.text) &&
    Boolean(threadId) &&
    // S9: a completed turn leaves the CLI subprocess resident; dispose() must
    // reap it. `before >= 1` proves it was resident, `after === 0` proves the
    // reap. (If the SDK reaped it early, `before` may be 0 — still a pass since
    // there is nothing to leak.)
    after === 0;
  console.log(ok ? '[live] PASS' : '[live] FAIL — see values above');

  await module.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

void main();
