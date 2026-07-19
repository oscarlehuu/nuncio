import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseModule } from '../../src/db/database.module';
import { PiAgentProvider } from '../../src/agents/providers/pi-agent.provider';
import { EventsRepository } from '../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../src/sessions/persistence/sessions.repository';
import { SettingsModule } from '../../src/settings/settings.module';

/**
 * REAL compaction round-trip (phase 06, plans/260719-engine-shell-and-compaction):
 * a live Pi session with the nuncio-engine rail, history seeded past the cut
 * budget through the SDK's own SessionManager, then `session.compact()` —
 * real machinery, real cheap-model narrative call, real post-compaction
 * continuation probe. The OFF path runs Pi's default compaction on the same
 * seeded shape for comparison; both summaries are printed for the eval report.
 *
 * Gated on real Pi auth; costs a few small LLM calls (seeded text is sent to
 * the summarizer once per path + one tiny probe turn per path).
 */

const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
const hasRealPiAuth = existsSync(join(piAgentDir, 'auth.json'));
const suite = hasRealPiAuth ? describe : describe.skip;

const SESSION_MODEL = 'cliproxyapi:claude-sonnet-4-6';
const PLAN_MARKER = 'wire the frobnicator relay into the composer drawer';
const VERIFY_MARKER = 'bun run gate:frobnicator';
const STEER_MARKER = 'keep the relay behind the NUNCIO_FROBNICATE flag';

interface LiveSessionInternals {
  sessionManager: {
    appendMessage(message: unknown): string;
    getEntries(): Array<{ type: string; summary?: string; fromHook?: boolean }>;
  };
  compact(customInstructions?: string): Promise<{ summary: string; tokensBefore: number }>;
  prompt(text: string): Promise<void>;
}

function seedTurn(index: number, filler: string) {
  return [
    {
      role: 'user',
      content: `Task step ${index}: ${filler}`,
      timestamp: Date.now(),
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: `Acknowledged step ${index}. ${filler.slice(0, 400)}` }],
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  ];
}

suite('Nuncio Engine compaction against real Pi machinery (integration)', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-compaction-int-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [PiAgentProvider],
    }).compile();
    provider = module.get(PiAgentProvider);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_ENGINE_COMPACTION;
  });

  async function seededCompaction(layerOn: boolean): Promise<{
    summary: string;
    fromExtension: boolean;
    probeAnswer: string;
  }> {
    process.env.NUNCIO_ENGINE_COMPACTION = layerOn ? 'on' : 'off';
    const cwd = mkdtempSync(join(tmpdir(), 'nuncio-compaction-ws-'));
    const created = sessions.create({
      prompt: 'compaction integration seed',
      provider: 'pi',
      model: SESSION_MODEL,
    });
    // Survivor sources in the durable Nuncio log (what the ON path must pin).
    events.append(created.id, 'plan_updated', {
      items: [
        { id: 'p1', text: 'map the relay event contract', status: 'done' },
        { id: 'p2', text: PLAN_MARKER, status: 'in_progress' },
        { id: 'p3', text: 'add the regression spec', status: 'pending' },
      ],
    });
    events.append(created.id, 'verify_result', {
      command: VERIFY_MARKER,
      ok: false,
      exitCode: 1,
      durationMs: 4200,
      outputTail: '2 tests failed: composer-drawer.spec.ts (relay not mounted)',
      timedOut: false,
    });

    // One tiny REAL turn to establish the live Pi session (rail attached).
    await provider.run(created.id, 'Reply with exactly: ready', {
      cwd,
      model: SESSION_MODEL,
      emit: () => {},
    });

    const handle = (provider as unknown as {
      activeSessions: Map<string, { session: LiveSessionInternals }>;
    }).activeSessions.get(created.id);
    if (!handle) throw new Error('live Pi session handle missing');
    const live = handle.session;

    // Seed ~280K chars (~70K estimated tokens) so the cut discards the head —
    // including the steer marker — while keeping the ~20K-token recent tail.
    const filler = 'The relay contract requires ordered delivery and idempotent redelivery. '.repeat(120);
    live.sessionManager.appendMessage({
      role: 'user',
      content: `Important instruction: ${STEER_MARKER}. Do not lose this constraint.`,
      timestamp: Date.now(),
    });
    for (let index = 0; index < 30; index += 1) {
      for (const message of seedTurn(index, filler)) live.sessionManager.appendMessage(message);
    }

    const result = await live.compact();
    const compactionEntries = live.sessionManager.getEntries()
      .filter((entry) => entry.type === 'compaction');
    const fromExtension = compactionEntries.some((entry) => entry.fromHook === true);

    // Continuation probe: does the post-compaction context still know the
    // pinned state well enough to answer without re-reading anything?
    await provider.steer(
      created.id,
      'From the current context only: (1) which plan item is in progress, '
      + '(2) what verify command failed, (3) which flag must the relay stay behind? '
      + 'Answer tersely with the three literal values.',
      { cwd, model: SESSION_MODEL, emit: () => {} },
    );
    const probeAnswer = [...events.list(created.id)]
      .reverse()
      .find((event) => event.type === 'assistant_message')
      ?.payload as { text?: string } | undefined;

    await provider.dispose(created.id);
    rmSync(cwd, { recursive: true, force: true });
    return {
      summary: result.summary,
      fromExtension,
      probeAnswer: probeAnswer?.text ?? '',
    };
  }

  it('ON: survivors ride the compaction verbatim and the session continues on them', async () => {
    const outcome = await seededCompaction(true);
    console.log('[compaction-eval] ON fromExtension:', outcome.fromExtension);
    console.log('[compaction-eval] ON summary >>>\n', outcome.summary, '\n<<<');
    console.log('[compaction-eval] ON probe >>>\n', outcome.probeAnswer, '\n<<<');

    expect(outcome.fromExtension).toBe(true);
    expect(outcome.summary).toContain('## Pinned session state');
    expect(outcome.summary).toContain(PLAN_MARKER);
    expect(outcome.summary).toContain(VERIFY_MARKER);
    expect(outcome.summary).toContain('read_session_history');
    expect(outcome.probeAnswer.toLowerCase()).toContain('frobnicator');
  }, 600_000);

  it('OFF: Pi default compaction runs; capture what survives for the comparison report', async () => {
    const outcome = await seededCompaction(false);
    console.log('[compaction-eval] OFF fromExtension:', outcome.fromExtension);
    console.log('[compaction-eval] OFF summary >>>\n', outcome.summary, '\n<<<');
    console.log('[compaction-eval] OFF probe >>>\n', outcome.probeAnswer, '\n<<<');
    console.log('[compaction-eval] OFF verbatim survival:', {
      plan: outcome.summary.includes(PLAN_MARKER),
      verify: outcome.summary.includes(VERIFY_MARKER),
      steer: outcome.summary.includes(STEER_MARKER),
    });

    expect(outcome.fromExtension).toBe(false);
    expect(outcome.summary.length).toBeGreaterThan(0);
  }, 600_000);
});
