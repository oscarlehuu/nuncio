// Unit tests for the pure provider-canary helpers (scripts/provider-canary-utils.mjs).
// The canary's cost rule and its event-shape verdict are plain functions so the
// expensive runner (scripts/provider-canary.mjs) stays a thin HTTP loop.
import { describe, expect, test } from 'bun:test';
import {
  assessCanaryEvents,
  CANARY_MARKER,
  isCheapTierModel,
  parseCanaryArgs,
  pickCanaryModel,
  renderCanaryReport,
} from './provider-canary-utils.mjs';

const model = (id, name = id) => ({ id, name });

describe('pickCanaryModel (never burn a flagship)', () => {
  test('pi picks a haiku-tier model over anything else', () => {
    const picked = pickCanaryModel('pi', [
      model('cliproxyapi:claude-opus-4-8', 'Claude Opus 4.8'),
      model('cliproxyapi:claude-haiku-4.5', 'Claude Haiku 4.5'),
      model('anthropic:claude-sonnet-4-6', 'Claude Sonnet 4.6'),
    ]);
    expect(picked).toEqual({ modelId: 'cliproxyapi:claude-haiku-4.5' });
  });

  test('codex picks the mini tier', () => {
    const picked = pickCanaryModel('codex', [
      model('codex:gpt-5.5'),
      model('codex:gpt-5.5-codex-mini'),
    ]);
    expect(picked).toEqual({ modelId: 'codex:gpt-5.5-codex-mini' });
  });

  test('cursor picks composer (matches by name when the id differs)', () => {
    const picked = pickCanaryModel('cursor', [
      model('cursor:sonic-9', 'Sonic 9'),
      model('cursor:c-2.5', 'Composer 2.5'),
    ]);
    expect(picked).toEqual({ modelId: 'cursor:c-2.5' });
  });

  test('claude picks haiku', () => {
    const picked = pickCanaryModel('claude', [
      model('claude:opus[1m]', 'Opus'),
      model('claude:haiku', 'Haiku'),
    ]);
    expect(picked).toEqual({ modelId: 'claude:haiku' });
  });

  test('mock uses its default model', () => {
    const picked = pickCanaryModel('mock', [
      model('mock:default', 'Mock Agent'),
      model('mock:builder', 'Mock Builder'),
    ]);
    expect(picked).toEqual({ modelId: 'mock:default' });
  });

  test('skips (never falls back to a flagship) when no cheap tier exists', () => {
    const picked = pickCanaryModel('pi', [model('cliproxyapi:claude-opus-4-8', 'Claude Opus 4.8')]);
    expect(picked.skip).toContain('no cheap-tier model');
  });

  test('unknown provider skips unless allowAnyModel opts in to its first model', () => {
    const models = [model('newsdk:frontier-1', 'Frontier 1')];
    expect(pickCanaryModel('newsdk', models).skip).toBeDefined();
    expect(pickCanaryModel('newsdk', models, { allowAnyModel: true })).toEqual({
      modelId: 'newsdk:frontier-1',
    });
  });

  test('a provider with zero models skips even with allowAnyModel', () => {
    expect(pickCanaryModel('pi', [], { allowAnyModel: true }).skip).toBeDefined();
  });
});

describe('assessCanaryEvents (event-shape verdict)', () => {
  const happyEvents = [
    { seq: 1, type: 'status', payload: { status: 'RUNNING' } },
    { seq: 2, type: 'assistant_delta', payload: { delta: 'NUNCIO_' } },
    { seq: 3, type: 'assistant_delta', payload: { delta: 'CANARY_OK' } },
    { seq: 4, type: 'assistant_message', payload: { text: 'NUNCIO_CANARY_OK' } },
    { seq: 5, type: 'status', payload: { status: 'IDLE' } },
  ];

  test('passes the full happy shape', () => {
    const verdict = assessCanaryEvents({
      events: happyEvents,
      sessionStatus: 'IDLE',
      marker: CANARY_MARKER,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.turns).toBe(1);
  });

  test('fails when the session did not settle IDLE', () => {
    const verdict = assessCanaryEvents({
      events: happyEvents,
      sessionStatus: 'ERROR',
      marker: CANARY_MARKER,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain('ERROR');
  });

  test('fails when no RUNNING status event was emitted', () => {
    const events = happyEvents.filter((e) => e.payload?.status !== 'RUNNING');
    const verdict = assessCanaryEvents({ events, sessionStatus: 'IDLE', marker: CANARY_MARKER });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain('RUNNING');
  });

  test('fails when nothing streamed (no assistant_delta)', () => {
    const events = happyEvents.filter((e) => e.type !== 'assistant_delta');
    const verdict = assessCanaryEvents({ events, sessionStatus: 'IDLE', marker: CANARY_MARKER });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain('assistant_delta');
  });

  test('fails when no assistant_message terminal text arrived', () => {
    const events = happyEvents.filter((e) => e.type !== 'assistant_message');
    const verdict = assessCanaryEvents({ events, sessionStatus: 'IDLE', marker: CANARY_MARKER });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain('assistant_message');
  });

  test('fails when the marker is missing from every assistant_message', () => {
    const events = happyEvents.map((e) =>
      e.type === 'assistant_message' ? { ...e, payload: { text: 'something else' } } : e,
    );
    const verdict = assessCanaryEvents({ events, sessionStatus: 'IDLE', marker: CANARY_MARKER });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain(CANARY_MARKER);
  });

  test('marker check is skipped when marker is null (mock mode)', () => {
    const events = happyEvents.map((e) =>
      e.type === 'assistant_message'
        ? { ...e, payload: { text: 'I received your task. In mock mode…' } }
        : e,
    );
    const verdict = assessCanaryEvents({ events, sessionStatus: 'IDLE', marker: null });
    expect(verdict.ok).toBe(true);
  });

  test('surfaces error events as failures even if the session settled IDLE', () => {
    const events = [...happyEvents, { seq: 6, type: 'error', payload: { message: 'boom' } }];
    const verdict = assessCanaryEvents({ events, sessionStatus: 'IDLE', marker: CANARY_MARKER });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain('boom');
  });
});

describe('parseCanaryArgs', () => {
  test('defaults: real mode, all providers, no flagship fallback', () => {
    expect(parseCanaryArgs([])).toEqual({
      mock: false,
      providers: null,
      allowAnyModel: false,
      timeoutMs: 120000,
      modelOverrides: {},
    });
  });

  test('parses --mock, --providers, --allow-any-model, --timeout', () => {
    expect(
      parseCanaryArgs(['--mock', '--providers', 'pi,codex', '--allow-any-model', '--timeout', '30000']),
    ).toEqual({
      mock: true,
      providers: ['pi', 'codex'],
      allowAnyModel: true,
      timeoutMs: 30000,
      modelOverrides: {},
    });
  });

  test('parses repeatable --model provider=modelId per-machine pins', () => {
    const args = parseCanaryArgs([
      '--model', 'pi=cliproxyapi:claude-sonnet-4-6',
      '--model', 'codex=codex:gpt-5.5-codex-mini',
    ]);
    expect(args.modelOverrides).toEqual({
      pi: 'cliproxyapi:claude-sonnet-4-6',
      codex: 'codex:gpt-5.5-codex-mini',
    });
  });

  test('rejects a malformed --model value', () => {
    expect(() => parseCanaryArgs(['--model', 'just-a-model-id'])).toThrow(/--model/);
  });

  test('rejects a non-numeric --timeout', () => {
    expect(() => parseCanaryArgs(['--timeout', 'soon'])).toThrow(/--timeout/);
  });

  test('rejects unknown flags (a typo must never silently flip mode on a credentialed machine)', () => {
    expect(() => parseCanaryArgs(['--mok'])).toThrow(/--mok/);
  });

  test('rejects an empty --providers list', () => {
    expect(() => parseCanaryArgs(['--providers', ''])).toThrow(/--providers/);
  });
});

describe('isCheapTierModel', () => {
  test('recognizes cheap tiers and flags everything else', () => {
    expect(isCheapTierModel('pi', 'cliproxyapi:claude-haiku-4.5')).toBe(true);
    expect(isCheapTierModel('pi', 'cliproxyapi:claude-opus-4-8')).toBe(false);
    expect(isCheapTierModel('newsdk', 'newsdk:frontier-1')).toBe(false);
  });
});

describe('renderCanaryReport', () => {
  test('renders one row per provider with verdict and notes', () => {
    const table = renderCanaryReport([
      { provider: 'pi', model: 'cliproxyapi:claude-haiku-4.5', ok: true, durationMs: 4200, turns: 1, notes: [] },
      { provider: 'codex', model: null, ok: null, durationMs: 0, turns: 0, notes: ['skipped: no cheap-tier model'] },
      { provider: 'cursor', model: 'cursor:c-2.5', ok: false, durationMs: 9000, turns: 1, notes: ['no assistant_delta events streamed'] },
    ]);
    expect(table).toContain('pi');
    expect(table).toContain('PASS');
    expect(table).toContain('SKIP');
    expect(table).toContain('FAIL');
    expect(table).toContain('no cheap-tier model');
  });
});
