import { describe, expect, it } from 'bun:test';
import {
  buildUpdateTarget,
  detectInstallMethod,
  type ProviderToolUpdateDefinition,
} from '../../../src/provider-updates/provider-update-helpers';

const tool: ProviderToolUpdateDefinition = {
  provider: 'codex',
  packageName: '@openai/codex',
  nativeUpdateArgs: ['update'],
  standalonePathMarkers: ['/.codex/packages/standalone/'],
  homebrewName: 'codex',
  homebrewKind: 'cask',
};

describe('provider update helper', () => {
  it('resolves package-manager update commands from install paths', () => {
    expect(target('/opt/homebrew/lib/node_modules/@openai/codex/bin/codex')).toBe(
      'npm install -g @openai/codex@latest',
    );
    expect(target('/Users/test/.bun/bin/codex')).toBe('bun i -g @openai/codex@latest');
    expect(target('/Users/test/.local/share/pnpm/codex')).toBe(
      'pnpm add -g @openai/codex@latest',
    );
  });

  it('resolves Homebrew and standalone installs without CLI-specific branches', () => {
    expect(target('/opt/homebrew/caskroom/codex/latest/codex')).toBe('brew upgrade --cask codex');
    expect(target('/Users/test/.codex/packages/standalone/current/bin/codex')).toBe(
      'codex update',
    );
  });

  it('falls back to the declared native update command for unknown install paths', () => {
    expect(detectInstallMethod('/custom/bin/codex', tool)).toBe('unknown');
    expect(target('/custom/bin/codex')).toBe('codex update');
  });
});

function target(realCommandPath: string): string | null {
  return buildUpdateTarget(tool, 'codex', realCommandPath).updateCommand;
}
