import { describe, expect, it } from 'vitest';
import { stripSessionPreambleForDisplay } from './session-preamble-display';

describe('stripSessionPreambleForDisplay', () => {
  it('returns plain prompts unchanged', () => {
    expect(stripSessionPreambleForDisplay('Fix the bug')).toBe('Fix the bug');
  });

  it('keeps only the user prompt after a Workspace preamble', () => {
    const stored = [
      '## Workspace',
      'branch: `main`',
      'base: `origin/dev`',
      '',
      '---',
      '',
      'what is your model',
    ].join('\n');
    expect(stripSessionPreambleForDisplay(stored)).toBe('what is your model');
  });

  it('keeps the last section when multiple preamble blocks are present', () => {
    const stored = ['## Brief', 'notes', '', '---', '', '## Workspace', 'x', '', '---', '', 'Do the thing'].join(
      '\n',
    );
    expect(stripSessionPreambleForDisplay(stored)).toBe('Do the thing');
  });

  it('treats nullish / blank input as empty', () => {
    expect(stripSessionPreambleForDisplay('')).toBe('');
    expect(stripSessionPreambleForDisplay('   ')).toBe('');
    expect(stripSessionPreambleForDisplay(null as unknown as string)).toBe('');
    expect(stripSessionPreambleForDisplay(undefined as unknown as string)).toBe('');
  });

  it('documents that an embedded separator truncates to the last section', () => {
    // Display-only split uses SESSION_PREAMBLE_SEPARATOR; user text that
    // happens to contain the same delimiter loses earlier sections.
    expect(
      stripSessionPreambleForDisplay('Before\n\n---\n\nAfter the break'),
    ).toBe('After the break');
  });
});
