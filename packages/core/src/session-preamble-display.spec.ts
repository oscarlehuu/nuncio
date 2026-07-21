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
});
