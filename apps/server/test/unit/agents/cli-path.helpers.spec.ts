import { describe, it, expect } from 'bun:test';
import { homedir } from 'node:os';
import { expandHome } from '../../../src/agents/providers/cli-path.helpers';
import { expandHome as expandHomeFromClaude } from '../../../src/agents/providers/claude-cli-resolver';
import { expandHome as expandHomeFromCodex } from '../../../src/agents/providers/codex-cli-resolver';

describe('expandHome', () => {
  const env = { HOME: '/home/nuncio' } as unknown as NodeJS.ProcessEnv;

  it('expands a bare ~ to HOME', () => {
    expect(expandHome('~', env)).toBe('/home/nuncio');
  });

  it('joins a ~/ prefix onto HOME', () => {
    expect(expandHome('~/.codex/bin', env)).toBe('/home/nuncio/.codex/bin');
  });

  it('passes an absolute path through unchanged', () => {
    expect(expandHome('/usr/local/bin/codex', env)).toBe('/usr/local/bin/codex');
  });

  it('leaves an embedded ~ (not a leading segment) untouched', () => {
    expect(expandHome('/opt/~weird/bin', env)).toBe('/opt/~weird/bin');
  });

  it('falls back to the OS home when HOME is unset', () => {
    expect(expandHome('~', {} as NodeJS.ProcessEnv)).toBe(homedir());
  });

  it('is the same function both resolvers re-export', () => {
    expect(expandHomeFromClaude).toBe(expandHome);
    expect(expandHomeFromCodex).toBe(expandHome);
  });
});
