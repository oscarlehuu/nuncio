/**
 * Data + pure logic behind the landing hero's interactive demo.
 *
 * The demo mimics a real Nuncio session: you pick a task, the "agent" streams a
 * transcript (thinking → tool calls → diff → test result → summary) block by
 * block, the session FSM moves CREATED → RUNNING → IDLE, and you can steer it
 * with a follow-up. Everything here is deterministic and side-effect free so it
 * can be unit-tested; the React component only drives timing and input.
 */

export type DemoBlockKind = 'user' | 'thinking' | 'tools' | 'assistant' | 'result';

export interface DemoTool {
  /** Short verb shown before the target, e.g. "Read", "Edited", "Ran". */
  verb: string;
  /** File path or command the tool acted on. */
  target: string;
}

export interface DemoDiff {
  file: string;
  /** Added lines (rendered green, prefixed with +). */
  add: string[];
  /** Removed lines (rendered red, prefixed with −). */
  del: string[];
}

export interface DemoResult {
  label: string;
  ok: boolean;
}

export interface DemoBlock {
  kind: DemoBlockKind;
  /** Milliseconds to wait after the previous block before revealing this one. */
  delayMs: number;
  text?: string;
  tools?: DemoTool[];
  diff?: DemoDiff;
  result?: DemoResult;
}

export interface DemoScenario {
  id: string;
  /** Label for the clickable prompt chip. */
  chip: string;
  /** The user's prompt — becomes the first transcript block. */
  prompt: string;
  /** provider:model shown in the composer footer, e.g. "cursor:composer-2.5". */
  model: string;
  /** Streamed blocks after the initial user prompt. */
  blocks: DemoBlock[];
}

export type DemoStatus = 'CREATED' | 'RUNNING' | 'IDLE';

export const SCENARIOS: DemoScenario[] = [
  {
    id: 'empty-array',
    chip: 'Fix a bug',
    prompt: 'Add an empty-array guard to parse.ts and run the tests',
    model: 'cursor:composer-2.5',
    blocks: [
      {
        kind: 'thinking',
        delayMs: 700,
        text: 'parse() maps over the array unconditionally — an empty input slips through and the caller assumes a non-empty result. I\'ll short-circuit, then confirm the suite still passes.',
      },
      {
        kind: 'assistant',
        delayMs: 900,
        text: "Found it — parse() doesn't guard the empty-array case. Adding an early return and re-running the suite.",
      },
      {
        kind: 'tools',
        delayMs: 850,
        tools: [
          { verb: 'Read', target: 'src/parse.ts' },
          { verb: 'Edited', target: 'src/parse.ts' },
          { verb: 'Ran', target: 'bun test src/parse.test.ts' },
        ],
        diff: {
          file: 'src/parse.ts',
          del: ['return arr.map(parseOne);'],
          add: ['if (arr.length === 0) return [];', 'return arr.map(parseOne);'],
        },
      },
      { kind: 'result', delayMs: 900, result: { label: '12 passed · 0 failed  (214ms)', ok: true } },
      {
        kind: 'assistant',
        delayMs: 700,
        text: 'Done. Added the guard at the top of parse() — no behavior change for non-empty input. Want me to open a PR against main?',
      },
    ],
  },
  {
    id: 'endpoint',
    chip: 'Add a feature',
    prompt: 'Add a GET /api/health/db endpoint that pings SQLite',
    model: 'pi:claude-sonnet-4',
    blocks: [
      {
        kind: 'thinking',
        delayMs: 700,
        text: 'I\'ll add a controller route that runs a cheap "SELECT 1" against the WAL database and reports latency, mirroring the existing /api/health shape.',
      },
      {
        kind: 'assistant',
        delayMs: 900,
        text: 'Adding a health route that pings the database and returns latency.',
      },
      {
        kind: 'tools',
        delayMs: 850,
        tools: [
          { verb: 'Edited', target: 'health.controller.ts' },
          { verb: 'Added', target: 'health.controller.spec.ts' },
          { verb: 'Ran', target: 'bun test test/unit/health' },
        ],
        diff: {
          file: 'health.controller.ts',
          del: [],
          add: [
            "@Get('db')",
            'async db() {',
            '  const t = performance.now();',
            "  this.db.query('SELECT 1').get();",
            '  return { ok: true, ms: performance.now() - t };',
            '}',
          ],
        },
      },
      { kind: 'result', delayMs: 900, result: { label: '3 passed · 0 failed  (88ms)', ok: true } },
      {
        kind: 'assistant',
        delayMs: 700,
        text: 'Shipped GET /api/health/db — returns { ok, ms } and self-skips gracefully if the DB is unreachable.',
      },
    ],
  },
  {
    id: 'explain',
    chip: 'Explain the code',
    prompt: 'Explain how the WebSocket relay resumes without gaps',
    model: 'codex:gpt-5.5-high',
    blocks: [
      {
        kind: 'thinking',
        delayMs: 700,
        text: 'The relay is append-only with a monotonic seq cursor; resume replays from the last acked seq. Let me trace the subscribe path to be precise.',
      },
      {
        kind: 'tools',
        delayMs: 800,
        tools: [
          { verb: 'Read', target: 'ws-relay.gateway.ts' },
          { verb: 'Read', target: 'docs/ws-relay-contract.md' },
        ],
      },
      {
        kind: 'assistant',
        delayMs: 900,
        text: 'Every event carries a monotonic seq. On subscribe you send the last seq you saw; the server replays the event log from there over the same duplex channel, then switches to live — so a dropped connection resumes gap-free instead of restarting the stream.',
      },
      { kind: 'result', delayMs: 800, result: { label: 'Traced 2 files · no code changes', ok: true } },
    ],
  },
];

/** Total time to fully stream a scenario, in ms (sum of block delays). */
export function scenarioDuration(scenario: DemoScenario): number {
  return scenario.blocks.reduce((sum, block) => sum + block.delayMs, 0);
}

/**
 * How many blocks are revealed at a given elapsed time. The initial user prompt
 * is always visible (it isn't part of `blocks`), so this counts streamed blocks.
 */
export function revealedCount(scenario: DemoScenario, elapsedMs: number): number {
  let acc = 0;
  for (let i = 0; i < scenario.blocks.length; i++) {
    acc += scenario.blocks[i].delayMs;
    if (elapsedMs < acc) return i;
  }
  return scenario.blocks.length;
}

/** Session FSM status for the number of revealed blocks. */
export function statusForRevealed(scenario: DemoScenario, revealed: number): DemoStatus {
  if (revealed <= 0) return 'CREATED';
  if (revealed >= scenario.blocks.length) return 'IDLE';
  return 'RUNNING';
}

/** Blocks appended when the user steers the finished session with a follow-up. */
export function steerBlocks(message: string): DemoBlock[] {
  const trimmed = message.trim();
  return [
    { kind: 'user', delayMs: 0, text: trimmed },
    {
      kind: 'assistant',
      delayMs: 900,
      text: 'On it — opening a pull request against main with the change and a summary.',
    },
    {
      kind: 'tools',
      delayMs: 800,
      tools: [
        { verb: 'Ran', target: 'git checkout -b nuncio/fix-parse' },
        { verb: 'Opened', target: 'pull request' },
      ],
    },
    { kind: 'result', delayMs: 800, result: { label: 'PR #128 opened · checks running', ok: true } },
  ];
}

export const STEER_SUGGESTIONS = ['Open a PR', 'Add a test', 'Also handle null input'];
