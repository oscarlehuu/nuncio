import { describe, expect, it } from 'bun:test';
import {
  buildRequestReproductionTool,
  MAX_LOGS_HINT_CHARS,
  MAX_STEP_CHARS,
  MAX_STEPS,
  normalizeReproductionInput,
  reproductionGateRef,
} from '../../../src/agents/pi-engine/request-reproduction-tool';

const okInput = {
  steps: [
    'From the worktree root run: NUNCIO_SMOKE_DEBUG_FAIL=signal bun run test:smoke-ui',
    'When it exits, check whether the logged PIDs are still alive with ps -p <pid>.',
  ],
  logsHint: 'Watch stderr for the // nuncio-debug NDJSON lines.',
};

describe('normalizeReproductionInput', () => {
  it('accepts well-formed steps and trims each', () => {
    const result = normalizeReproductionInput({
      steps: ['  run the repro  ', 'check the PID'],
      logsHint: '  stderr  ',
    });
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.steps).toEqual(['run the repro', 'check the PID']);
      expect(result.value.logsHint).toBe('stderr');
    }
  });

  it('rejects a non-object input', () => {
    expect('error' in normalizeReproductionInput('nope')).toBe(true);
    expect('error' in normalizeReproductionInput(null)).toBe(true);
    expect('error' in normalizeReproductionInput([])).toBe(true);
  });

  it('rejects missing / empty steps', () => {
    expect('error' in normalizeReproductionInput({})).toBe(true);
    expect('error' in normalizeReproductionInput({ steps: [] })).toBe(true);
    expect('error' in normalizeReproductionInput({ steps: 'not an array' })).toBe(true);
  });

  it('filters blank steps and rejects when nothing survives', () => {
    const kept = normalizeReproductionInput({ steps: ['   ', 'real step', ''] });
    expect('value' in kept).toBe(true);
    if ('value' in kept) expect(kept.value.steps).toEqual(['real step']);
    expect('error' in normalizeReproductionInput({ steps: ['  ', '\n', ''] })).toBe(true);
  });

  it('parses steps handed as a JSON string (Pi sometimes stringifies args)', () => {
    const result = normalizeReproductionInput({ steps: JSON.stringify(['a step', 'another']) });
    expect('value' in result).toBe(true);
    if ('value' in result) expect(result.value.steps).toEqual(['a step', 'another']);
  });

  it('accepts exactly MAX_STEPS and rejects one past it', () => {
    const at = Array.from({ length: MAX_STEPS }, (_, i) => `step ${i}`);
    const over = Array.from({ length: MAX_STEPS + 1 }, (_, i) => `step ${i}`);
    expect('value' in normalizeReproductionInput({ steps: at })).toBe(true);
    expect('error' in normalizeReproductionInput({ steps: over })).toBe(true);
  });

  it('accepts a step at the char cap and rejects one past it (code points, not bytes)', () => {
    expect('value' in normalizeReproductionInput({ steps: ['x'.repeat(MAX_STEP_CHARS)] })).toBe(true);
    expect('error' in normalizeReproductionInput({ steps: ['x'.repeat(MAX_STEP_CHARS + 1)] })).toBe(true);
    // Emoji counts as one code point apiece even though it is many bytes.
    expect('value' in normalizeReproductionInput({ steps: ['😀'.repeat(MAX_STEP_CHARS)] })).toBe(true);
  });

  it('treats logsHint as optional and caps it', () => {
    expect('value' in normalizeReproductionInput({ steps: ['s'] })).toBe(true);
    expect('value' in normalizeReproductionInput({ steps: ['s'], logsHint: 'h'.repeat(MAX_LOGS_HINT_CHARS) })).toBe(true);
    expect('error' in normalizeReproductionInput({ steps: ['s'], logsHint: 'h'.repeat(MAX_LOGS_HINT_CHARS + 1) })).toBe(true);
  });
});

describe('reproductionGateRef', () => {
  it('is deterministic per (session, nonce) and distinct across nonces', () => {
    const ref = reproductionGateRef('sess-1', 'call-1');
    expect(ref).toHaveLength(8);
    expect(reproductionGateRef('sess-1', 'call-1')).toBe(ref);
    expect(reproductionGateRef('sess-1', 'call-2')).not.toBe(ref);
    expect(reproductionGateRef('sess-2', 'call-1')).not.toBe(ref);
  });
});

describe('buildRequestReproductionTool.execute', () => {
  const tool = buildRequestReproductionTool() as {
    execute: (id: string, params: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  };

  it('acknowledges a valid request and tells the agent to wait', async () => {
    const result = await tool.execute('call-1', okInput);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text.toLowerCase()).toContain('end your turn');
  });

  it('returns an error result (not a throw) on bad input', async () => {
    const result = await tool.execute('call-2', { steps: [] });
    expect(result.isError).toBe(true);
  });
});
