// Live end-to-end sanity for Phase 3 (images + tool_end pairing) against the REAL
// Claude Agent SDK (haiku, /tmp workspace). Not part of the committed test suite —
// it needs a logged-in Claude CLI and makes real model calls. Run with:
//   bun run plans/260706-claude-provider/spike/p3-images-tools-live.ts
//
// Checks (PASS/FAIL printed per check):
//   1. A generated 2x2 red PNG attachment → the reply mentions "red".
//   2. A Bash-using prompt → a tool_start AND a matching tool_end pair (same
//      callId, isError:false).
//   3. An injected in-process runtime tool round-trip still pairs tool_start /
//      tool_end for the same callId.
import { Test } from '@nestjs/testing';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClaudeAgentProvider } from '../../../apps/server/src/agents/providers/claude-agent.provider';
import { DatabaseModule } from '../../../apps/server/src/db/database.module';
import { EventsRepository } from '../../../apps/server/src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../apps/server/src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../apps/server/src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../apps/server/src/settings/settings.module';

/** Build a self-contained 2x2 solid-red PNG, returned base64 (no external files). */
function redPngBase64(): string {
  const crc32 = (buf: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of buf) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); // width
  ihdr.writeUInt32BE(2, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  // Two rows of two red pixels, each row prefixed with a filter byte (0).
  const row = Buffer.from([0, 255, 0, 0, 255, 0, 0]);
  const raw = Buffer.concat([row, row]);
  const idat = deflateSync(raw);
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'nuncio-claude-p3-'));
  const workspace = mkdtempSync(join(tmpdir(), 'nuncio-claude-p3-ws-'));
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

  // ── Check 1: red PNG attachment → reply mentions red ──────────────────────
  {
    const created = sessions.create({ prompt: 'x', provider: 'claude', model: 'claude:haiku', workspace });
    await provider.run(created.id, 'What single color is this image? Answer with one word.', {
      cwd: workspace,
      model: 'claude:haiku',
      attachments: [{ kind: 'image', mimeType: 'image/png', data: redPngBase64() }],
    });
    provider.dispose(created.id);
    const assistant = events.list(created.id).findLast((e) => e.type === 'assistant_message');
    const text = ((assistant?.payload as { text?: string })?.text ?? '').toLowerCase();
    const pass = text.includes('red');
    console.log(`[live] check1 image — reply: ${JSON.stringify(text)}`);
    results.push({ name: 'red PNG attachment → reply mentions red', pass });
  }

  // ── Check 2: Bash prompt → tool_start + matching tool_end pair ─────────────
  {
    const created = sessions.create({ prompt: 'x', provider: 'claude', model: 'claude:haiku', workspace });
    await provider.run(
      created.id,
      'Run exactly this bash command and report the result: echo nuncio-tool-end-check',
      {
        cwd: workspace,
        model: 'claude:haiku',
        requestProviderApproval: async () => ({ requestId: 'auto', decision: 'approve' as const }),
      },
    );
    provider.dispose(created.id);
    const list = events.list(created.id);
    const starts = list.filter((e) => e.type === 'tool_start');
    const ends = list.filter((e) => e.type === 'tool_end');
    const startIds = new Set(starts.map((e) => (e.payload as { callId?: string }).callId));
    const paired = ends.filter((e) => startIds.has((e.payload as { callId?: string }).callId));
    const noError = paired.some((e) => (e.payload as { isError?: boolean }).isError === false);
    const pass = starts.length > 0 && paired.length === starts.length && noError;
    console.log(
      `[live] check2 bash — starts:${starts.length} ends:${ends.length} paired:${paired.length} anyNonError:${noError}`,
    );
    results.push({ name: 'Bash tool_start pairs with a matching non-error tool_end', pass });
  }

  // ── Check 3: injected runtime tool → tool_start/tool_end round-trip ────────
  {
    const created = sessions.create({ prompt: 'x', provider: 'claude', model: 'claude:haiku', workspace });
    await provider.run(
      created.id,
      'Call the `nuncio_echo` tool with the argument message set to "ping", then tell me what it returned.',
      {
        cwd: workspace,
        model: 'claude:haiku',
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
              execute: (input) => `echoed:${(input as { message?: string }).message ?? ''}`,
            },
          ],
        },
      },
    );
    provider.dispose(created.id);
    const list = events.list(created.id);
    const start = list.find((e) => e.type === 'tool_start' && (e.payload as { tool?: string }).tool === 'nuncio_echo');
    const startId = (start?.payload as { callId?: string })?.callId;
    const end = list.find(
      (e) => e.type === 'tool_end' && (e.payload as { callId?: string }).callId === startId,
    );
    const pass = Boolean(start) && Boolean(end);
    console.log(
      `[live] check3 runtime tool — start:${Boolean(start)} (callId ${startId}), matching tool_end:${Boolean(end)}`,
    );
    results.push({ name: 'runtime tool tool_start/tool_end round-trip pairs', pass });
  }

  console.log('');
  for (const r of results) console.log(`[live] ${r.pass ? 'PASS' : 'FAIL'} — ${r.name}`);
  const ok = results.every((r) => r.pass);
  console.log(ok ? '[live] ALL PASS' : '[live] SOME FAILED — see values above');

  cleanup();
  process.exit(ok ? 0 : 1);
}

void main();
