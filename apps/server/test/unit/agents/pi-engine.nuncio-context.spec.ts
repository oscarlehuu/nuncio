import { describe, expect, it } from 'bun:test';
import {
  buildNuncioContext,
  NUNCIO_CONTEXT_MAX_BYTES,
} from '../../../src/agents/pi-engine/nuncio-context';
import type { ContextFactDto } from '../../../src/context/context-facts.types';
import { byteLength } from '../../../src/orchestration/byte-truncate';

function fact(
  key: string,
  value: string,
  overrides: Partial<ContextFactDto> = {},
): ContextFactDto {
  return {
    id: key,
    projectPath: '/repo',
    key,
    value,
    provenance: 'founder',
    sourceSessionId: null,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('buildNuncioContext', () => {
  it('returns nothing without project facts, even when a brief exists', () => {
    expect(buildNuncioContext({ facts: [] })).toBe('');
    expect(buildNuncioContext({ facts: [], brief: { goal: 'Do not emit this.' } })).toBe('');
  });

  it('renders stable fact priority before the latest handoff brief', () => {
    const input = {
      facts: [
        fact('older', 'Older fact.', { updatedAt: 10 }),
        fact('pinned', 'Pinned fact.', { pinned: true, updatedAt: 1 }),
        fact('newer', 'Newer fact.', { updatedAt: 20 }),
      ],
      brief: { goal: 'Ship the engine context.' },
    };

    const first = buildNuncioContext(input);
    const permuted = buildNuncioContext({ ...input, facts: [...input.facts].reverse() });

    expect(first).toBe(permuted);
    expect(first.startsWith('## Nuncio project context')).toBe(true);
    expect(first.indexOf('**pinned**')).toBeLessThan(first.indexOf('**newer**'));
    expect(first.indexOf('**newer**')).toBeLessThan(first.indexOf('**older**'));
    expect(first.indexOf('**older**')).toBeLessThan(first.indexOf('## Handoff brief'));
  });

  it('uses a deterministic key and id tie-break for equal-priority facts', () => {
    const a = fact('same-key', 'First row.', { id: 'a' });
    const b = fact('same-key', 'Second row.', { id: 'b' });

    expect(buildNuncioContext({ facts: [b, a] })).toBe(
      buildNuncioContext({ facts: [a, b] }),
    );
  });

  it('keeps the hard byte cap and truncates the brief at a sentence boundary', () => {
    const output = buildNuncioContext({
      facts: [fact('runtime', 'Use Bun.')],
      brief: {
        goal: 'First complete sentence. Second sentence must not survive this deliberately small budget.',
      },
    }, 150);

    expect(byteLength(output)).toBeLessThanOrEqual(150);
    expect(output).toContain('First complete sentence.');
    expect(output).not.toContain('Second sentence must not survive');
    expect(output.endsWith('_(Nuncio context truncated)_')).toBe(true);
    expect(output).not.toContain('�');
  });

  it('never exceeds the default 4 KiB budget with multibyte input', () => {
    const output = buildNuncioContext({
      facts: Array.from({ length: 8 }, (_, index) =>
        fact(`fact-${index}`, `Sentence ${index}. ${'🌌'.repeat(480)}`, { updatedAt: index }),
      ),
      brief: { goal: `Keep UTF-8 valid. ${'🚀'.repeat(1200)}` },
    });

    expect(byteLength(output)).toBeLessThanOrEqual(NUNCIO_CONTEXT_MAX_BYTES);
    expect(output).not.toContain('�');
  });
});
