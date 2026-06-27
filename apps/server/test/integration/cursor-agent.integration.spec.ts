import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, JsonlLocalAgentStore } from '@cursor/sdk';

const hasCursorKey =
  !!process.env.CURSOR_API_KEY?.trim() && process.env.NUNCIO_FORCE_MOCK !== '1';
const suite = hasCursorKey ? describe : describe.skip;

const HANDLED_SDK_EVENT_TYPES = new Set([
  'assistant',
  'tool_call',
  'thinking',
  'status',
  'system',
  'user',
  'task',
  'request',
  'usage',
]);

suite('CursorAgentProvider with real Cursor API key (integration)', () => {
  let dataDir: string;
  let wsDir: string;
  let storeDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-cursor-integration-'));
    wsDir = join(dataDir, 'ws');
    storeDir = join(dataDir, 'store');
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it(
    'runs a real prompt end-to-end under Bun with escape hatches',
    async () => {
      const agent = await Agent.create({
        apiKey: process.env.CURSOR_API_KEY!,
        model: { id: 'composer-2.5' },
        local: {
          cwd: wsDir,
          useHttp1ForAgent: true,
          store: new JsonlLocalAgentStore(storeDir),
        },
      } as Parameters<typeof Agent.create>[0]);

      try {
        const run = await agent.send('Reply with the word PONG and nothing else.');
        const seenTypes = new Set<string>();
        let streamText = '';

        for await (const event of run.stream()) {
          seenTypes.add(event.type);
          if (event.type === 'assistant') {
            for (const block of event.message.content) {
              if (block.type === 'text') streamText += block.text;
            }
          }
        }

        for (const type of seenTypes) {
          expect(HANDLED_SDK_EVENT_TYPES.has(type)).toBe(true);
        }

        const result = await run.wait();
        expect(result.status).toBe('finished');

        const finalText = result.result ?? streamText;
        expect(finalText.toUpperCase()).toContain('PONG');
      } catch (err) {
        const name = err instanceof Error ? err.constructor.name : String(err);
        const message = err instanceof Error ? err.message : String(err);
        const isAuthError =
          name.includes('Authentication') ||
          name.includes('Configuration') ||
          message.toLowerCase().includes('api key');
        if (!isAuthError) {
          throw new Error(
            `Cursor SDK platform/sandbox failure on this machine (${name}: ${message}). ` +
              'Investigate @cursor/sdk platform package and sandbox-helper support.',
          );
        }
        throw err;
      } finally {
        agent.close();
      }
    },
    60_000,
  );
});
