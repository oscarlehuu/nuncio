import { describe, expect, it } from 'bun:test';
import {
  buildExternalMemoriesBlock,
  EXTERNAL_MEMORIES_DEFAULT_BYTES,
  EXTERNAL_MEMORIES_MAX_BYTES,
  ExternalMemoriesService,
} from '../../../src/agents/pi-engine/external-memories';
import { byteLength } from '../../../src/orchestration/byte-truncate';

describe('buildExternalMemoriesBlock', () => {
  it('uses a 12 KiB default index budget', () => {
    expect(EXTERNAL_MEMORIES_DEFAULT_BYTES).toBe(12288);
  });

  it('keeps the header and omission marker within a byte budget', () => {
    const output = buildExternalMemoriesBlock({
      claude: {
        indexContent: Array.from({ length: 30 }, (_, index) =>
          `- [Memory ${index}](memory-${index}.md) — ${'detail '.repeat(8)}`).join('\n'),
      },
      codex: { groups: [], hasSummary: false },
    }, 520);

    expect(output.startsWith('## External agent memories')).toBe(true);
    expect(output).toContain('_(more omitted)_');
    expect(byteLength(output)).toBeLessThanOrEqual(520);
  });

  it('skips one oversized line and still includes later entries that fit', () => {
    const output = buildExternalMemoriesBlock({
      claude: { indexContent: `${'x'.repeat(1000)}\n- [Small](small.md) — fits` },
    }, 420);

    expect(output).toContain('- [Small](small.md) — fits');
    expect(output).toContain('_(more omitted)_');
    expect(byteLength(output)).toBeLessThanOrEqual(420);
  });

  it('fails closed for a non-finite budget', () => {
    const output = buildExternalMemoriesBlock({
      claude: { indexContent: 'x'.repeat(EXTERNAL_MEMORIES_MAX_BYTES * 4) },
    }, Number.NaN);

    expect(byteLength(output)).toBeLessThanOrEqual(EXTERNAL_MEMORIES_MAX_BYTES);
  });

  it('renders matching Codex groups and the global summary as read ids', () => {
    const output = buildExternalMemoriesBlock({
      codex: {
        groups: [{
          id: 'group-1',
          title: 'Repo delivery',
          scope: 'release\nand verification',
          appliesTo: ['/repo'],
          content: '# Task Group: Repo delivery',
        }],
        hasSummary: true,
      },
    }, EXTERNAL_MEMORIES_MAX_BYTES);

    expect(output).toContain('- Repo delivery — release and verification  [id: group-1]');
    expect(output).toContain('[id: summary]');
    expect(output).toContain('read_external_memory');
  });
});

describe('ExternalMemoriesService mode gating', () => {
  const sources = {
    loadClaude: () => ({ indexContent: '- [Claude](claude.md)', ids: ['claude'], locations: [] }),
    loadCodex: () => ({
      groups: [{ id: 'group-1', title: 'Codex', scope: 'repo', appliesTo: ['/repo'], content: 'body' }],
      hasSummary: true,
    }),
  };
  const service = new ExternalMemoriesService(sources as never);
  const roots = { claudeDir: '/claude', codexHome: '/codex' };

  it('supports off, claude, codex, and all without reading disabled stores', () => {
    expect(service.buildForProject('/repo', 'off', EXTERNAL_MEMORIES_DEFAULT_BYTES, roots)).toBe('');
    expect(service.buildForProject('/repo', 'claude', EXTERNAL_MEMORIES_DEFAULT_BYTES, roots)).toContain('Claude Code memories');
    expect(service.buildForProject('/repo', 'claude', EXTERNAL_MEMORIES_DEFAULT_BYTES, roots)).not.toContain('Codex CLI memories');
    expect(service.buildForProject('/repo', 'codex', EXTERNAL_MEMORIES_DEFAULT_BYTES, roots)).toContain('Codex CLI memories');
    expect(service.buildForProject('/repo', 'codex', EXTERNAL_MEMORIES_DEFAULT_BYTES, roots)).not.toContain('Claude Code memories');
    const all = service.buildForProject('/repo', 'all', EXTERNAL_MEMORIES_DEFAULT_BYTES, roots);
    expect(all).toContain('Claude Code memories');
    expect(all).toContain('Codex CLI memories');
  });

  it('offers only Codex ids that survived the injected index budget', () => {
    const manySources = {
      ...sources,
      loadCodex: () => ({
        groups: Array.from({ length: 20 }, (_, index) => ({
          id: `group-${index + 1}`,
          title: `Group ${index + 1}`,
          scope: 'x'.repeat(80),
          appliesTo: ['/repo'],
          content: `body ${index + 1}`,
        })),
        hasSummary: true,
      }),
    };
    const bounded = new ExternalMemoriesService(manySources as never);
    const block = bounded.buildForProject('/repo', 'codex', 520, roots);
    const ids = bounded.availableIds('/repo', 'codex', 'codex', roots, 520);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(21);
    for (const id of ids) expect(block).toContain(`[id: ${id}]`);
  });
});
