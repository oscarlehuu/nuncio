import { describe, expect, it } from 'vitest';
import { summarizeToolCall, summarizeToolGroup } from './tool-summary';

describe('summarizeToolCall', () => {
  it('Read with path and offset/limit → "Read <path> L<a>-<b>"', () => {
    expect(summarizeToolCall('read', { path: '/Users/me/proj/foo.ts', offset: 99, limit: 50 })).toEqual({
      verb: 'Read',
      subject: 'proj/foo.ts',
      context: ' L100-149',
    });
  });

  it('Read with startLine/endLine → "Read <path> L<a>-<b>"', () => {
    expect(summarizeToolCall('Read', { file_path: 'src/x.ts', startLine: 10, endLine: 12 })).toEqual({
      verb: 'Read',
      subject: 'src/x.ts',
      context: ' L10-12',
    });
  });

  it('Read with single startLine=endLine → "L<a>"', () => {
    expect(summarizeToolCall('Read', { path: 'x.ts', startLine: 5, endLine: 5 }).context).toBe(' L5');
  });

  it('Read without range', () => {
    expect(summarizeToolCall('read', { path: '/Users/me/foo.ts' })).toEqual({
      verb: 'Read',
      subject: 'foo.ts',
      context: undefined,
    });
  });

  it('bash with cmd → "Ran <cmd>"', () => {
    expect(summarizeToolCall('bash', { cmd: 'ls -la' })).toEqual({ verb: 'Ran', subject: 'ls -la' });
  });

  it('Run with command', () => {
    expect(summarizeToolCall('Run', { command: 'pnpm test' })).toEqual({ verb: 'Ran', subject: 'pnpm test' });
  });

  it('Grep with pattern + path', () => {
    expect(summarizeToolCall('grep', { pattern: 'TODO', path: 'src' })).toEqual({
      verb: 'Grepped',
      subject: 'TODO',
      context: ' in src',
    });
  });

  it('Glob with pattern', () => {
    expect(summarizeToolCall('Glob', { pattern: '**/*.env*' })).toEqual({
      verb: 'Searched files',
      subject: '**/*.env*',
      context: undefined,
    });
  });

  it('Edit with path', () => {
    expect(summarizeToolCall('Edit', { path: 'apps/web/src/app.tsx' })).toEqual({
      verb: 'Edited',
      subject: 'apps/web/src/app.tsx',
    });
  });

  it('Write with file_path', () => {
    expect(summarizeToolCall('write', { file_path: 'new.txt' })).toEqual({
      verb: 'Wrote',
      subject: 'new.txt',
    });
  });

  it('WebFetch with url', () => {
    expect(summarizeToolCall('WebFetch', { url: 'https://example.com' })).toEqual({
      verb: 'Fetched',
      subject: 'https://example.com',
    });
  });

  it('WebSearch with query', () => {
    expect(summarizeToolCall('WebSearch', { query: 'bun sqlite' })).toEqual({
      verb: 'Searched the web',
      subject: 'bun sqlite',
    });
  });

  it('unknown tool → "Used <tool>"', () => {
    expect(summarizeToolCall('mcp_tool_xyz', {})).toEqual({ verb: 'Used', subject: 'mcp_tool_xyz' });
  });

  it('shortens /Users/<name>/ prefix', () => {
    expect(summarizeToolCall('Read', { path: '/Users/a1241968/Desktop/Oscar/nuncio/README.md' }).subject).toBe(
      'Desktop/Oscar/nuncio/README.md',
    );
  });

  it('handles missing input gracefully', () => {
    expect(summarizeToolCall('read', undefined)).toEqual({ verb: 'Read', subject: '' });
  });
});

describe('summarizeToolGroup', () => {
  it('single category — Read', () => {
    expect(
      summarizeToolGroup([
        { tool: 'read', input: { path: 'a.ts' } },
        { tool: 'read', input: { path: 'b.ts' } },
      ]),
    ).toBe('Read 2 files');
  });

  it('single category — bash', () => {
    expect(
      summarizeToolGroup([
        { tool: 'bash', input: { cmd: 'ls' } },
        { tool: 'bash', input: { cmd: 'pwd' } },
        { tool: 'bash', input: { cmd: 'whoami' } },
      ]),
    ).toBe('Ran 3 commands');
  });

  it('mixed categories — first verb capitalized, rest lowercase', () => {
    expect(
      summarizeToolGroup([
        { tool: 'read', input: { path: 'a.ts' } },
        { tool: 'grep', input: { pattern: 'x' } },
        { tool: 'grep', input: { pattern: 'y' } },
        { tool: 'bash', input: { cmd: 'ls' } },
      ]),
    ).toBe('Read 1 file, searched 2 times, ran 1 command');
  });

  it('edit category', () => {
    expect(
      summarizeToolGroup([
        { tool: 'edit', input: { path: 'a.ts' } },
        { tool: 'edit', input: { path: 'b.ts' } },
      ]),
    ).toBe('Edited 2 files');
  });

  it('empty list', () => {
    expect(summarizeToolGroup([])).toBe('Ran tools');
  });

  it('three categories', () => {
    expect(
      summarizeToolGroup([
        { tool: 'read', input: { path: 'a' } },
        { tool: 'bash', input: { cmd: 'x' } },
        { tool: 'Glob', input: { pattern: '*' } },
      ]),
    ).toBe('Read 1 file, ran 1 command, searched 1 time');
  });

  it('webfetch', () => {
    expect(
      summarizeToolGroup([
        { tool: 'WebFetch', input: { url: 'https://a.com' } },
        { tool: 'WebFetch', input: { url: 'https://b.com' } },
      ]),
    ).toBe('Fetched 2 URLs');
  });

  it('unknown tool falls back to "used"', () => {
    expect(
      summarizeToolGroup([
        { tool: 'mcp_xyz', input: {} },
        { tool: 'mcp_xyz', input: {} },
      ]),
    ).toBe('Used 2 tools');
  });
});
