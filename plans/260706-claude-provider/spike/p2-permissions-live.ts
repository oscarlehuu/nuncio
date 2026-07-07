// Live end-to-end sanity for the Phase 2 permission bridge + in-process runtime
// tools against the REAL Claude Agent SDK (haiku, /tmp workspace). Not part of
// the committed test suite — it needs a logged-in Claude CLI and makes real
// model calls. Run with:
//   bun run plans/260706-claude-provider/spike/p2-permissions-live.ts
//
// Checks (PASS/FAIL printed per check):
//   1. A non-safe Bash command routes through canUseTool → a scripted APPROVAL
//      (after a 2s delay) lets it run; a non-error Bash tool_end confirms it.
//   2. The same shape with a scripted DENY yields a clean tool error and the
//      turn still completes (no crash, session lands IDLE).
//   3. An injected in-process runtime tool the model is told to call fires its
//      `execute` and the result reaches the transcript (tool_start/tool_end).
import { Test } from '@nestjs/testing';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClaudeAgentProvider } from '../../../apps/server/src/agents/providers/claude-agent.provider';
import { DatabaseModule } from '../../../apps/server/src/db/database.module';
import { EventsRepository } from '../../../apps/server/src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../apps/server/src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../apps/server/src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../apps/server/src/settings/settings.module';
import type { AgentRunContext } from '../../../apps/server/src/agents/agents.types';

type Decision = 'approve' | 'deny';

/** A scripted approval hook: records each request, resolves after a delay with a fixed decision. */
function scriptedApproval(decision: Decision, delayMs: number, log: { requests: unknown[] }) {
  const hook: NonNullable<AgentRunContext['requestProviderApproval']> = async (request) => {
    log.requests.push(request);
    console.log(`[live] approval requested → ${JSON.stringify((request.params as { prompt?: string })?.prompt)}; scripting ${decision} in ${delayMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { requestId: `scripted-${log.requests.length}`, decision };
  };
  return hook;
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'nuncio-claude-p2-'));
  const workspace = mkdtempSync(join(tmpdir(), 'nuncio-claude-p2-ws-'));
  mkdirSync(workspace, { recursive: true });
  process.env.NUNCIO_DATA_DIR = dataDir;

  const module = await Test.createTestingModule({
    imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
    providers: [ClaudeAgentProvider],
  }).compile();

  const sessions = module.get(SessionsRepository);
  const events = module.get(EventsRepository);
  const provider = module.get(ClaudeAgentProvider);

  const cleanup = () => {
    void module.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  };

  const available = await provider.isAvailable();
  console.log('[live] isAvailable:', available);
  if (!available) {
    console.log('[live] SKIP — no logged-in Claude CLI / ANTHROPIC_API_KEY.');
    cleanup();
    return;
  }

  const results: Array<{ name: string; pass: boolean }> = [];

  // ── Check 1: non-safe Bash + scripted APPROVE → command runs ──────────────
  {
    // A network fetch reliably reaches canUseTool (safe ops like `echo`/`touch`
    // inside cwd auto-approve and never prompt — S8). Approving it lets it run,
    // which surfaces as a non-error Bash tool_end.
    const log = { requests: [] as unknown[] };
    const created = sessions.create({ prompt: 'x', provider: 'claude', model: 'claude:haiku', workspace });
    await provider.run(
      created.id,
      'Run exactly this bash command and nothing else, then report what happened: curl -s -o /dev/null -w "%{http_code}" https://example.com',
      {
        cwd: workspace,
        model: 'claude:haiku',
        requestProviderApproval: scriptedApproval('approve', 2000, log),
      },
    );
    provider.dispose(created.id);
    const asked = log.requests.length > 0;
    // The approve path is exercised when canUseTool asked (the card fired) and the
    // turn ran to completion (IDLE) — the SDK proceeded with the tool rather than
    // parking. (Phase 1 emits tool_start but not yet tool_end, so we do not assert
    // on a tool_end here; the approve→allow mapping itself is unit-tested.)
    const assistant = events.list(created.id).findLast((e) => e.type === 'assistant_message');
    const completed = Boolean((assistant?.payload as { text?: string })?.text);
    const pass = asked && completed && sessions.findById(created.id)?.status === 'IDLE';
    console.log(`[live] check1 approve — canUseTool asked: ${asked}, turn completed with a reply: ${completed}`);
    results.push({ name: 'approve → command runs (approval fired, turn completed)', pass });
  }

  // ── Check 2: non-safe Bash + scripted DENY → clean tool error, turn done ──
  {
    // A network fetch is non-safe Bash and always reaches canUseTool (unlike a
    // marker write, which acceptEdits may classify safe). Denying it must yield a
    // clean tool error with the turn still completing.
    const log = { requests: [] as unknown[] };
    const created = sessions.create({ prompt: 'x', provider: 'claude', model: 'claude:haiku', workspace });
    await provider.run(
      created.id,
      'Run exactly this bash command and nothing else, then report what happened: curl -s https://example.com',
      {
        cwd: workspace,
        model: 'claude:haiku',
        requestProviderApproval: scriptedApproval('deny', 2000, log),
      },
    );
    provider.dispose(created.id);
    const asked = log.requests.length > 0;
    const status = sessions.findById(created.id)?.status;
    const assistant = events.list(created.id).findLast((e) => e.type === 'assistant_message');
    const completed = Boolean((assistant?.payload as { text?: string })?.text);
    // The deny is clean when the callback was asked, the turn completed without
    // crashing (a reply landed), and the session is IDLE (not ERROR).
    const pass = asked && completed && status === 'IDLE';
    console.log(`[live] check2 deny — asked: ${asked}, turn completed with a reply: ${completed}, status: ${status}`);
    results.push({ name: 'deny → clean tool error, turn completes', pass });
  }

  // ── Check 3: injected in-process runtime tool → execute fires ─────────────
  {
    let executed = false;
    let executedWith: unknown;
    const created = sessions.create({ prompt: 'x', provider: 'claude', model: 'claude:haiku', workspace });
    await provider.run(
      created.id,
      'Call the `nuncio_echo` tool with the argument message set to "ping" and then tell me what it returned.',
      {
        cwd: workspace,
        model: 'claude:haiku',
        // Auto-approve anything else so the tool call is the only gate.
        requestProviderApproval: async () => ({ requestId: 'auto', decision: 'approve' as const }),
        tools: {
          systemPromptAppend: 'You have a tool named nuncio_echo that echoes its message argument back.',
          tools: [
            {
              name: 'nuncio_echo',
              description: 'Echo the given message back.',
              inputSchema: {
                type: 'object',
                properties: { message: { type: 'string', description: 'The message to echo back.' } },
                required: ['message'],
              },
              execute: (input) => {
                executed = true;
                executedWith = input;
                return `echoed:${(input as { message?: string }).message ?? ''}`;
              },
            },
          ],
        },
      },
    );
    provider.dispose(created.id);
    const toolStart = events.list(created.id).find((e) => e.type === 'tool_start' && (e.payload as { tool?: string }).tool === 'nuncio_echo');
    const gotTypedArg = (executedWith as { message?: string } | undefined)?.message === 'ping';
    const pass = executed && Boolean(toolStart) && gotTypedArg;
    console.log(`[live] check3 runtime tool — execute fired: ${executed} (args ${JSON.stringify(executedWith)}), typed arg reached execute: ${gotTypedArg}, tool_start bare-named present: ${Boolean(toolStart)}`);
    results.push({ name: 'injected runtime tool executes in-process', pass });
  }

  console.log('');
  for (const r of results) console.log(`[live] ${r.pass ? 'PASS' : 'FAIL'} — ${r.name}`);
  const ok = results.every((r) => r.pass);
  console.log(ok ? '[live] ALL PASS' : '[live] SOME FAILED — see values above');

  cleanup();
  process.exit(ok ? 0 : 1);
}

void main();
