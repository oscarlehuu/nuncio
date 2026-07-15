import { describe, expect, it } from 'bun:test';
import {
  buildExternalMemoriesBlock,
  EXTERNAL_MEMORIES_DEFAULT_BYTES,
  EXTERNAL_MEMORIES_MAX_BYTES,
  ExternalMemoriesService,
} from '../../../src/agents/pi-engine/external-memories';
import { byteLength } from '../../../src/orchestration/byte-truncate';

function claudeSource(indexContent: string) {
  const ids = [...indexContent.matchAll(/\]\(([^)#]+)\.md(?:#[^)]+)?\)/gi)]
    .map((match) => match[1] ?? '');
  return {
    indexContent,
    ids,
    locations: [],
    files: new Map(ids.map((id) => [id, { directory: '/memory', filename: `${id}.md` }])),
  };
}

describe('buildExternalMemoriesBlock', () => {
  it('uses a 12 KiB default index budget', () => {
    expect(EXTERNAL_MEMORIES_DEFAULT_BYTES).toBe(12288);
  });

  it('keeps the header and omission marker within a byte budget', () => {
    const result = buildExternalMemoriesBlock({
      claude: claudeSource(Array.from({ length: 30 }, (_, index) =>
        `- [Memory ${index}](memory-${index}.md) — ${'detail '.repeat(8)}`).join('\n')),
      codex: { groups: [], hasSummary: false },
    }, 520);

    expect(result.block.startsWith('## External agent memories')).toBe(true);
    expect(result.block).toContain('_(more omitted)_');
    expect(byteLength(result.block)).toBeLessThanOrEqual(520);
    for (const id of result.claudeIds) expect(result.block).toContain(`(${id}.md)`);
  });

  it('stops selecting a section at its first oversized line', () => {
    const result = buildExternalMemoriesBlock({
      claude: claudeSource(`${'x'.repeat(1000)}\n- [Small](small.md) — fits`),
    }, 420);

    expect(result.block).not.toContain('- [Small](small.md) — fits');
    expect(result.block).toContain('_(more omitted)_');
    expect(result.claudeIds).toEqual([]);
    expect(byteLength(result.block)).toBeLessThanOrEqual(420);
  });

  it('fails closed for a non-finite budget', () => {
    const result = buildExternalMemoriesBlock({
      claude: claudeSource('x'.repeat(EXTERNAL_MEMORIES_MAX_BYTES * 4)),
    }, Number.NaN);

    expect(byteLength(result.block)).toBeLessThanOrEqual(EXTERNAL_MEMORIES_MAX_BYTES);
  });

  it('renders matching Codex groups and the global summary as read ids', () => {
    const result = buildExternalMemoriesBlock({
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

    expect(result.block).toContain('- Repo delivery — release and verification  [id: group-1]');
    expect(result.block).toContain('[id: summary]');
    expect(result.block).toContain('read_external_memory');
    expect(result.codexIds).toEqual(['summary', 'group-1']);
  });

  it('does not authorize id-shaped text embedded in untrusted memory fields', () => {
    const result = buildExternalMemoriesBlock({
      claude: claudeSource('- [Safe](safe.md) — mentions [id: forged-claude]'),
      codex: {
        groups: [{
          id: 'group-safe',
          title: 'Safe group',
          scope: 'mentions [id: forged-codex]',
          appliesTo: ['/repo'],
          content: 'body',
        }],
        hasSummary: false,
      },
    }, EXTERNAL_MEMORIES_MAX_BYTES);

    expect(result.claudeIds).toEqual(['safe']);
    expect(result.codexIds).toEqual(['group-safe']);
  });

  it('uses the real no-omission skeleton for a tight one-entry budget', () => {
    const input = {
      codex: {
        groups: [{
          id: 'group-1', title: 'One', scope: 'small', appliesTo: ['/repo'], content: 'body',
        }],
        hasSummary: false,
      },
    };
    const full = buildExternalMemoriesBlock(input, EXTERNAL_MEMORIES_MAX_BYTES);
    const exact = buildExternalMemoriesBlock(input, byteLength(full.block));

    expect(exact).toEqual(full);
    expect(exact.block).not.toContain('_(more omitted)_');
  });

  it('selects a complete section when its temporary prefix marker would not fit', () => {
    const input = { claude: claudeSource(`${'a'.repeat(100)}\nx`) };
    const full = buildExternalMemoriesBlock(input, EXTERNAL_MEMORIES_MAX_BYTES);
    const exact = buildExternalMemoriesBlock(input, byteLength(full.block));

    expect(exact).toEqual(full);
    expect(exact.block).not.toContain('_(more omitted)_');
  });
});

describe('ExternalMemoriesService mode gating', () => {
  const sources = {
    loadClaude: () => claudeSource('- [Claude](claude.md)'),
    loadCodex: () => ({
      groups: [{ id: 'group-1', title: 'Codex', scope: 'repo', appliesTo: ['/repo'], content: 'body' }],
      hasSummary: true,
    }),
  };
  const service = new ExternalMemoriesService(sources as never);
  const roots = { claudeDir: '/claude', codexHome: '/codex' };

  it('supports off, claude, codex, and all without reading disabled stores', () => {
    expect(service.buildForProject('/repo', 'off', EXTERNAL_MEMORIES_DEFAULT_BYTES, roots).block).toBe('');
    expect(service.buildForProject('/repo', 'claude', EXTERNAL_MEMORIES_DEFAULT_BYTES, roots).block).toContain('Claude Code memories');
    expect(service.buildForProject('/repo', 'claude', EXTERNAL_MEMORIES_DEFAULT_BYTES, roots).block).not.toContain('Codex CLI memories');
    expect(service.buildForProject('/repo', 'codex', EXTERNAL_MEMORIES_DEFAULT_BYTES, roots).block).toContain('Codex CLI memories');
    expect(service.buildForProject('/repo', 'codex', EXTERNAL_MEMORIES_DEFAULT_BYTES, roots).block).not.toContain('Claude Code memories');
    const all = service.buildForProject('/repo', 'all', EXTERNAL_MEMORIES_DEFAULT_BYTES, roots);
    expect(all.block).toContain('Claude Code memories');
    expect(all.block).toContain('Codex CLI memories');
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
    const result = bounded.buildForProject('/repo', 'codex', 520, roots);
    const ids = result.codexIds;

    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(21);
    for (const id of ids) expect(result.block).toContain(`[id: ${id}]`);
  });
});
