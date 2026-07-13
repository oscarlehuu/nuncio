import { describe, it, expect } from 'bun:test';
import type { AgentProvider, AgentRunContext, EventEmitter } from '../../../src/agents/agents.types';
import type { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import type { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import type { SessionDto } from '../../../src/sessions/domain/sessions.types';

/**
 * One event captured off the provider's `emit` hook. Providers emit the event
 * exactly as appended (type + payload, plus seq/createdAt), so the contract can
 * assert on the live stream without re-reading the log.
 */
export interface CapturedEvent {
  type: string;
  payload: unknown;
  seq?: number;
  createdAt?: number;
}

/**
 * Everything a per-provider spec must wire so the shared contract can drive it.
 * The provider's SDK/CLI is already stubbed at the adapter boundary by the spec;
 * these hooks let the contract arrange the stub for each scenario without
 * knowing which provider it is.
 */
export interface ProviderContractHarness {
  provider: AgentProvider;
  sessions: SessionsRepository;
  events: EventsRepository;
  /** Create a fresh session row and return it (status CREATED). */
  createSession(prompt: string): SessionDto;
  /** Run context (model/cwd/etc.) the provider needs; `emit` is added by the contract. */
  runContext?: AgentRunContext;
  /**
   * Arrange the stub so the next `run()`/`steer()` streams `deltas` as
   * `assistant_delta` events and then completes with authoritative text
   * `finalText`. Called before every happy-path run.
   */
  arrangeSuccess(deltas: string[], finalText: string): void;
  /** The two deltas the contract streams for the coalescing assertion. */
  readonly successDeltas: [string, string];
  /** The SDK's authoritative terminal text for `arrangeSuccess(successDeltas, …)`. */
  readonly successFinalText: string;
  /**
   * Arrange the stub so the next `run()` fails mid-turn (provider lands ERROR).
   * Returning a function lets async-completing providers (Codex) trigger the
   * failure after `run()` has started; sync providers return undefined.
   */
  arrangeError(): void | (() => void);
  /**
   * Await `run()` settling. Providers that complete synchronously inside
   * `run()` can just `await run`; providers whose completion arrives via a
   * separate notification override this to pump the stub. Defaults to awaiting
   * the promise directly.
   */
  settleRun?(run: Promise<void>): Promise<void>;
  /**
   * Capability honesty: whether this provider declares `interrupt: true` and so
   * must prove interrupt actually works. When false, the contract asserts the
   * declared-off capability rejects cleanly instead.
   */
  exercisesInterrupt?: boolean;
  /**
   * For interrupt-capable providers: arrange a live streaming run, invoke
   * interrupt, and resolve once the interrupt has taken effect. Must leave the
   * session settled (IDLE, not stuck RUNNING). Required iff `exercisesInterrupt`.
   */
  arrangeAndInterrupt?(sessionId: string, emit: EventEmitter): Promise<void>;
}

export type MakeHarness = () => Promise<ProviderContractHarness> | ProviderContractHarness;

const RUN_SETTLE_TIMEOUT_MS = 1000;

/** Poll a predicate off the event log with a hard timeout — no sleeps. */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > RUN_SETTLE_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function statusEvents(events: CapturedEvent[]): string[] {
  return events
    .filter((event) => event.type === 'status')
    .map((event) => (event.payload as { status: string }).status);
}

function ctxWithEmit(harness: ProviderContractHarness, emit: EventEmitter): AgentRunContext {
  return { ...(harness.runContext ?? {}), emit };
}

async function settle(harness: ProviderContractHarness, run: Promise<void>): Promise<void> {
  if (harness.settleRun) return harness.settleRun(run);
  await run;
}

/**
 * The provider conformance contract — one factory every `AgentProvider` must
 * pass, so a session-layer edge case is written once and every engine inherits
 * it (ADR-004 made executable). Instantiate per provider with its SDK stubbed at
 * the adapter boundary; see the per-provider `*.contract.spec.ts` files.
 */
export function describeAgentProviderContract(name: string, makeHarness: MakeHarness): void {
  describe(`AgentProvider contract: ${name}`, () => {
    it('run() drives session status RUNNING then IDLE', async () => {
      const h = await makeHarness();
      const created = h.createSession('drive the lifecycle');
      expect(h.sessions.findById(created.id)?.status).toBe('CREATED');

      const emitted: CapturedEvent[] = [];
      h.arrangeSuccess([...h.successDeltas], h.successFinalText);
      const run = h.provider.run(created.id, created.prompt, ctxWithEmit(h, (e) => emitted.push(e)));
      await settle(h, run);

      expect(h.sessions.findById(created.id)?.status).toBe('IDLE');
      const statuses = statusEvents(emitted);
      const runningAt = statuses.indexOf('RUNNING');
      const idleAt = statuses.indexOf('IDLE');
      expect(runningAt).toBeGreaterThanOrEqual(0);
      expect(idleAt).toBeGreaterThan(runningAt);
    });

    it('streams text as an immediate durable head plus coalesced tail events', async () => {
      const h = await makeHarness();
      const created = h.createSession('stream some text');
      const emitted: CapturedEvent[] = [];
      h.arrangeSuccess([...h.successDeltas], h.successFinalText);

      const run = h.provider.run(created.id, created.prompt, ctxWithEmit(h, (e) => emitted.push(e)));
      await settle(h, run);

      const persistedDeltas = h.events
        .list(created.id)
        .filter((event) => event.type === 'assistant_delta');
      const persistedText = persistedDeltas
        .map((event) => (event.payload as { delta: string }).delta)
        .join('');
      expect((persistedDeltas[0]?.payload as { delta: string }).delta).toBe(h.successDeltas[0]);
      expect(persistedText).toBe(h.successDeltas.join(''));
      const emittedDeltas = emitted.filter((event) => event.type === 'assistant_delta');
      expect(emittedDeltas).toEqual(persistedDeltas);
    });

    it('emits a terminal assistant_message matching the SDK authoritative text', async () => {
      const h = await makeHarness();
      const created = h.createSession('finish with a message');
      const emitted: CapturedEvent[] = [];
      h.arrangeSuccess([...h.successDeltas], h.successFinalText);

      const run = h.provider.run(created.id, created.prompt, ctxWithEmit(h, (e) => emitted.push(e)));
      await settle(h, run);

      const message = h.events
        .list(created.id)
        .findLast((event) => event.type === 'assistant_message');
      expect(message).toBeDefined();
      expect((message?.payload as { text: string }).text).toBe(h.successFinalText);
    });

    it('lands the session in ERROR with an error event and never stuck RUNNING', async () => {
      const h = await makeHarness();
      const created = h.createSession('make it fail');
      const emitted: CapturedEvent[] = [];
      const trigger = h.arrangeError();

      const run = h.provider.run(created.id, created.prompt, ctxWithEmit(h, (e) => emitted.push(e)));
      trigger?.();
      await settle(h, run);

      const session = h.sessions.findById(created.id);
      expect(session?.status).toBe('ERROR');
      expect(session?.status).not.toBe('RUNNING');
      const all = h.events.list(created.id);
      expect(all.some((event) => event.type === 'error')).toBe(true);
      expect(
        statusEvents(all as CapturedEvent[]).at(-1),
      ).toBe('ERROR');
    });

    it('dispose() is idempotent — twice and on an unknown session never throws', async () => {
      const h = await makeHarness();
      expect(() => h.provider.dispose('no-such-session')).not.toThrow();

      const created = h.createSession('dispose me');
      h.arrangeSuccess([...h.successDeltas], h.successFinalText);
      const run = h.provider.run(created.id, created.prompt, ctxWithEmit(h, () => {}));
      await settle(h, run);

      expect(() => h.provider.dispose(created.id)).not.toThrow();
      expect(() => h.provider.dispose(created.id)).not.toThrow();
    });

    it('steer() after dispose starts a fresh session without throwing', async () => {
      const h = await makeHarness();
      const created = h.createSession('first run');
      h.arrangeSuccess([...h.successDeltas], h.successFinalText);
      const firstRun = h.provider.run(created.id, created.prompt, ctxWithEmit(h, () => {}));
      await settle(h, firstRun);
      expect(h.sessions.findById(created.id)?.status).toBe('IDLE');

      // Dispose drops the in-process handle; the event log is the durable context.
      h.provider.dispose(created.id);

      const emitted: CapturedEvent[] = [];
      h.arrangeSuccess([...h.successDeltas], h.successFinalText);
      const steerRun = h.provider.steer(
        created.id,
        'continue after dispose',
        ctxWithEmit(h, (e) => emitted.push(e)),
      );
      await settle(h, steerRun);

      expect(h.sessions.findById(created.id)?.status).toBe('IDLE');
      const all = h.events.list(created.id);
      expect(all.some((event) => event.type === 'steer_message')).toBe(true);
      // The revived run streamed through the same shared orchestration.
      expect(statusEvents(all as CapturedEvent[]).at(-1)).toBe('IDLE');
    });

    it('capability honesty: interrupt matches its declared capability', async () => {
      const h = await makeHarness();

      if (h.exercisesInterrupt) {
        // Declared-on: interrupt must actually work when exercised.
        expect(h.provider.capabilities.interrupt).toBe(true);
        expect(typeof h.provider.interrupt).toBe('function');
        expect(h.arrangeAndInterrupt).toBeDefined();

        const created = h.createSession('interruptible run');
        const emitted: CapturedEvent[] = [];
        await h.arrangeAndInterrupt!(created.id, (e) => emitted.push(e));

        // Interrupt must leave the session settled, never stuck RUNNING.
        await waitUntil(
          () => h.sessions.findById(created.id)?.status !== 'RUNNING',
          'session settles after interrupt',
        );
        expect(h.sessions.findById(created.id)?.status).not.toBe('RUNNING');
        return;
      }

      // Declared-off: exercising the capability must fail cleanly — either the
      // method is absent, or calling it no-ops/rejects without throwing
      // synchronously and without corrupting session state.
      expect(h.provider.capabilities.interrupt).toBe(false);
      const maybeInterrupt = h.provider.interrupt?.bind(h.provider);
      if (maybeInterrupt) {
        await expect(maybeInterrupt('no-such-session')).resolves.toBeUndefined();
      }
    });
  });
}
