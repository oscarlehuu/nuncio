import { describe, expect, it } from 'bun:test';
import {
  buildSpawnTaskTool,
  MAX_PROMPT_CHARS,
  MAX_TITLE_CHARS,
  MAX_TLDR_CHARS,
  MIN_PROMPT_CHARS,
  normalizeSpawnTaskInput,
  spawnTaskRef,
} from '../../../src/agents/pi-engine/spawn-task-tool';

const okInput = {
  title: 'Remove the dead retry path in relay.ts',
  tldr: 'The legacy retry branch is unreachable after the queue refactor.',
  prompt:
    'In apps/server/src/relay/relay.service.ts delete the unreachable legacyMode retry branch and its helper, then update the relay unit test.',
};

describe('normalizeSpawnTaskInput', () => {
  it('accepts a well-formed proposal and trims it', () => {
    const result = normalizeSpawnTaskInput({ ...okInput, title: `  ${okInput.title}  `, cwd: ' /w ' });
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.title).toBe(okInput.title);
      expect(result.value.cwd).toBe('/w');
    }
  });

  it('rejects a non-object input', () => {
    expect('error' in normalizeSpawnTaskInput('nope')).toBe(true);
    expect('error' in normalizeSpawnTaskInput(null)).toBe(true);
    expect('error' in normalizeSpawnTaskInput([])).toBe(true);
  });

  it('rejects blank title / tldr / prompt', () => {
    expect('error' in normalizeSpawnTaskInput({ ...okInput, title: '   ' })).toBe(true);
    expect('error' in normalizeSpawnTaskInput({ ...okInput, tldr: '' })).toBe(true);
    expect('error' in normalizeSpawnTaskInput({ ...okInput, prompt: '  ' })).toBe(true);
  });

  it('accepts a title of exactly the cap and rejects one past it (code points, not bytes)', () => {
    const at = 'x'.repeat(MAX_TITLE_CHARS);
    const over = 'x'.repeat(MAX_TITLE_CHARS + 1);
    expect('value' in normalizeSpawnTaskInput({ ...okInput, title: at })).toBe(true);
    expect('error' in normalizeSpawnTaskInput({ ...okInput, title: over })).toBe(true);
    // 60 emoji is 60 code points even though it is many bytes.
    const emoji = '😀'.repeat(MAX_TITLE_CHARS);
    expect('value' in normalizeSpawnTaskInput({ ...okInput, title: emoji })).toBe(true);
  });

  it('rejects a trivial (too short to be self-contained) prompt', () => {
    expect('error' in normalizeSpawnTaskInput({ ...okInput, prompt: 'fix the bug' })).toBe(true);
  });

  it('accepts a prompt at the minimum length and rejects one below it', () => {
    expect('value' in normalizeSpawnTaskInput({ ...okInput, prompt: 'a'.repeat(MIN_PROMPT_CHARS) })).toBe(true);
    expect('error' in normalizeSpawnTaskInput({ ...okInput, prompt: 'a'.repeat(MIN_PROMPT_CHARS - 1) })).toBe(true);
  });

  it('rejects a prompt past the max size', () => {
    expect('error' in normalizeSpawnTaskInput({ ...okInput, prompt: 'a'.repeat(MAX_PROMPT_CHARS + 1) })).toBe(true);
  });

  it('accepts a tldr at the cap and rejects one past it', () => {
    expect('value' in normalizeSpawnTaskInput({ ...okInput, tldr: 't'.repeat(MAX_TLDR_CHARS) })).toBe(true);
    expect('error' in normalizeSpawnTaskInput({ ...okInput, tldr: 't'.repeat(MAX_TLDR_CHARS + 1) })).toBe(true);
  });
});

describe('spawnTaskRef', () => {
  it('is deterministic and title+prompt sensitive', () => {
    const ref = spawnTaskRef(okInput.title, okInput.prompt);
    expect(ref).toHaveLength(8);
    expect(spawnTaskRef(okInput.title, okInput.prompt)).toBe(ref);
    expect(spawnTaskRef(`${okInput.title}!`, okInput.prompt)).not.toBe(ref);
    // Whitespace-insensitive (matches the boundary trim).
    expect(spawnTaskRef(`  ${okInput.title}  `, okInput.prompt)).toBe(ref);
  });
});

describe('buildSpawnTaskTool.execute', () => {
  const tool = buildSpawnTaskTool() as {
    execute: (id: string, params: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  };

  it('echoes the ref on a valid proposal so dismiss_task can target it', async () => {
    const result = await tool.execute('call-1', okInput);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain(spawnTaskRef(okInput.title, okInput.prompt));
  });

  it('returns an error result (not a throw) on bad input', async () => {
    const result = await tool.execute('call-2', { title: '', tldr: '', prompt: '' });
    expect(result.isError).toBe(true);
  });
});
