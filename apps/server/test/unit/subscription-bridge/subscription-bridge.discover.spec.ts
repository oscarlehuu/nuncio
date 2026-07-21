import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverCliproxyInstalls,
  parseCliproxyConfigYaml,
} from '../../../src/subscription-bridge/subscription-bridge.discover';

describe('parseCliproxyConfigYaml', () => {
  it('extracts port, auth-dir, and masked api keys', () => {
    const yaml = `
port: 8317
auth-dir: "~/.cli-proxy-api"
api-keys:
  - "pi-local-7c3f9a2e8b1d4f6a0c2e5b8d"
  - "claudex-aa3dcd9492ab724bd1138aacc56237f4"
codex:
  reasoning-effort: "high"
`;
    const parsed = parseCliproxyConfigYaml(yaml);
    expect(parsed.port).toBe(8317);
    expect(parsed.authDir).toBe('~/.cli-proxy-api');
    expect(parsed.apiKeys).toEqual([
      { index: 0, preview: '••••0c2e5b8d', raw: 'pi-local-7c3f9a2e8b1d4f6a0c2e5b8d' },
      { index: 1, preview: '••••c56237f4', raw: 'claudex-aa3dcd9492ab724bd1138aacc56237f4' },
    ]);
  });

  it('tolerates missing api-keys', () => {
    const parsed = parseCliproxyConfigYaml('port: 9000\n');
    expect(parsed.port).toBe(9000);
    expect(parsed.apiKeys).toEqual([]);
    expect(parsed.authDir).toBeNull();
  });
});

describe('discoverCliproxyInstalls', () => {
  it('finds config.yaml under candidate roots and reports auth files', () => {
    const root = mkdtempSync(join(tmpdir(), 'nuncio-cliproxy-discover-'));
    try {
      const installDir = join(root, 'cliproxyapi');
      const authDir = join(root, 'auth');
      mkdirSync(installDir, { recursive: true });
      mkdirSync(authDir, { recursive: true });
      writeFileSync(
        join(installDir, 'config.yaml'),
        `port: 8317\nauth-dir: "${authDir}"\napi-keys:\n  - "secret-key-abcdef12"\n`,
        'utf8',
      );
      writeFileSync(join(authDir, 'claude-token.json'), '{}', 'utf8');
      writeFileSync(join(authDir, 'codex-oauth.json'), '{}', 'utf8');
      writeFileSync(join(installDir, 'cli-proxy-api'), '#!/bin/sh\n', { mode: 0o755 });

      const found = discoverCliproxyInstalls({
        homeDir: root,
        candidateConfigPaths: [join(installDir, 'config.yaml')],
        candidateBinPaths: [join(installDir, 'cli-proxy-api')],
      });

      expect(found).toHaveLength(1);
      expect(found[0]?.configPath).toBe(join(installDir, 'config.yaml'));
      expect(found[0]?.port).toBe(8317);
      expect(found[0]?.binaryPath).toBe(join(installDir, 'cli-proxy-api'));
      expect(found[0]?.accounts).toEqual({ claude: true, codex: true });
      expect(found[0]?.apiKeys[0]?.preview).toContain('••••');
      expect(found[0]?.apiKeys[0]).toEqual({ index: 0, preview: expect.stringContaining('••••') });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty when nothing is installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'nuncio-cliproxy-empty-'));
    try {
      expect(
        discoverCliproxyInstalls({
          homeDir: root,
          candidateConfigPaths: [join(root, 'missing', 'config.yaml')],
          candidateBinPaths: [],
        }),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
