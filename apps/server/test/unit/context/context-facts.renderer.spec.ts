import { renderContextFacts } from '../../../src/context/context-facts.renderer';
import type { ContextFactDto } from '../../../src/context/context-facts.types';

function fact(over: Partial<ContextFactDto> = {}): ContextFactDto {
  return {
    id: 'f1', projectPath: '/p', key: 'build-command', value: 'use make', provenance: 'founder',
    sourceSessionId: null, pinned: false, createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('renderContextFacts', () => {
  it('returns an empty string (no header) for an empty store', () => {
    expect(renderContextFacts([], 4096, { toolsEnabled: false })).toBe('');
  });

  it('renders a header and a bullet per fact', () => {
    const out = renderContextFacts(
      [fact({ key: 'build-command', value: 'use make' }), fact({ id: 'f2', key: 'deploy-freeze', value: 'no deploys' })],
      4096,
      { toolsEnabled: false },
    );
    expect(out).toContain('## Project facts (managed by nuncio)');
    expect(out).toContain('- **build-command**: use make');
    expect(out).toContain('- **deploy-freeze**: no deploys');
  });

  it('orders pinned facts first, then updated_at desc', () => {
    const out = renderContextFacts(
      [
        fact({ id: 'a', key: 'a', updatedAt: 10, pinned: false }),
        fact({ id: 'b', key: 'b', updatedAt: 20, pinned: false }),
        fact({ id: 'c', key: 'c', updatedAt: 1, pinned: true }),
      ],
      4096,
      { toolsEnabled: false },
    );
    const keys = out.split('\n').filter((l) => l.startsWith('- **')).map((l) => l.match(/\*\*(.+?)\*\*/)![1]);
    expect(keys).toEqual(['c', 'b', 'a']); // pinned c, then b (20), then a (10)
  });

  it('greedily packs and skips a whole fact that does not fit (never mid-fact)', () => {
    const out = renderContextFacts(
      [
        fact({ id: 'p', key: 'pinned', value: 'small', pinned: true, updatedAt: 100 }),
        fact({ id: 'big', key: 'big', value: 'x'.repeat(400), updatedAt: 50 }),
        fact({ id: 'tiny', key: 'tiny', value: 'y', updatedAt: 10 }),
      ],
      120,
      { toolsEnabled: false },
    );
    expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(120);
    // The pinned fact is included whole; the oversized 'big' is skipped, not truncated.
    expect(out).toContain('**pinned**: small');
    expect(out).not.toContain('xxxx');
  });

  it('adds an omission footer without the tool reference when tools are disabled', () => {
    const facts = Array.from({ length: 20 }, (_, i) => fact({ id: `f${i}`, key: `k${i}`, value: 'v'.repeat(80), updatedAt: i }));
    const out = renderContextFacts(facts, 300, { toolsEnabled: false });
    expect(out).toMatch(/_\(\d+ more facts omitted\)_/);
    expect(out).not.toContain('ask via context tools');
  });

  it('the footer references context tools only when they are enabled', () => {
    const facts = Array.from({ length: 20 }, (_, i) => fact({ id: `f${i}`, key: `k${i}`, value: 'v'.repeat(80), updatedAt: i }));
    const out = renderContextFacts(facts, 300, { toolsEnabled: true });
    expect(out).toContain('ask via context tools');
  });

  it('no footer when everything fits', () => {
    const out = renderContextFacts([fact()], 4096, { toolsEnabled: true });
    expect(out).not.toContain('omitted');
  });

  it('never evicts a pinned fact to make room for the footer (evicts lowest priority)', () => {
    // Budget fits header + pinned + unpinned but NOT the footer too; an oversized
    // fact is omitted (so a footer is required). The footer-fit step must drop the
    // unpinned fact, never the pinned one at the front.
    const facts = [
      fact({ id: 'pin', key: 'pinned-fact', value: 'keep me', pinned: true, updatedAt: 100 }),
      fact({ id: 'unp', key: 'unpinned-fact', value: 'evict me', pinned: false, updatedAt: 50 }),
      fact({ id: 'big', key: 'oversized', value: 'z'.repeat(500), pinned: false, updatedAt: 10 }),
    ];
    // Header(31) + '- **pinned-fact**: keep me'(~26) + '- **unpinned-fact**: evict me'(~29) ≈ 88;
    // a footer (~28) pushes past a 100-byte budget → the unpinned line is shed.
    const out = renderContextFacts(facts, 100, { toolsEnabled: false });
    expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(100);
    expect(out).toContain('**pinned-fact**: keep me'); // pinned survives
    expect(out).not.toContain('unpinned-fact'); // lowest-priority evicted
    expect(out).toMatch(/_\(\d+ more facts omitted\)_/); // footer present
  });
});
