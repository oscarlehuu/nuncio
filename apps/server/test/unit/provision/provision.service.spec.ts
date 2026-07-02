import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProvisionService, normalizeTargetUrl } from '../../../src/provision/provision.service';
import type { SettingsService } from '../../../src/settings/settings.service';

interface FakeSettingsOptions {
  agentDir: string;
  dbValues?: Record<string, string>;
}

function fakeSettings(options: FakeSettingsOptions): {
  service: SettingsService;
  writes: Array<[string, string]>;
} {
  const writes: Array<[string, string]> = [];
  const service = {
    resolve: (key: string) => (key === 'PI_AGENT_DIR' ? options.agentDir : options.dbValues?.[key]),
    resolveSource: (key: string) =>
      options.dbValues && key in options.dbValues
        ? { value: options.dbValues[key], source: 'db' as const }
        : { value: undefined, source: null },
    set: (key: string, value: string) => {
      writes.push([key, value]);
    },
  } as unknown as SettingsService;
  return { service, writes };
}

describe('normalizeTargetUrl', () => {
  it('normalizes to an http(s) origin', () => {
    expect(normalizeTargetUrl('host.ts.net:3000')).toBe('http://host.ts.net:3000');
    expect(normalizeTargetUrl('http://host:3000/path')).toBe('http://host:3000');
    expect(normalizeTargetUrl('ftp://host')).toBeNull();
    expect(normalizeTargetUrl('')).toBeNull();
  });
});

describe('ProvisionService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuncio-provision-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('collect gathers pi files and db-backed non-path settings', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), '{"a":1}');
    writeFileSync(join(dir, 'settings.json'), '{"s":1}');
    const { service } = fakeSettings({
      agentDir: dir,
      dbValues: { CURSOR_API_KEY: 'ck-123', GITHUB_TOKEN: 'gh-456' },
    });

    const payload = new ProvisionService(service).collect();
    expect(Object.keys(payload.piAgent ?? {}).sort()).toEqual(['auth.json', 'settings.json']);
    expect(payload.settings).toEqual({ CURSOR_API_KEY: 'ck-123', GITHUB_TOKEN: 'gh-456' });
  });

  it('collect never includes path-type settings', () => {
    const { service } = fakeSettings({
      agentDir: dir,
      dbValues: { NUNCIO_WORKSPACES_DIR: '/Users/a1241968/ws', CURSOR_API_KEY: 'ck' },
    });
    const payload = new ProvisionService(service).collect();
    expect(payload.settings).toEqual({ CURSOR_API_KEY: 'ck' });
  });

  it('apply writes pi files 0600, backing up existing ones', () => {
    writeFileSync(join(dir, 'auth.json'), 'OLD');
    const { service } = fakeSettings({ agentDir: dir });

    const result = new ProvisionService(service).apply({
      piAgent: { 'auth.json': 'NEW', 'models.json': '{"m":1}' },
    });

    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe('NEW');
    expect(statSync(join(dir, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe('{"m":1}');
    expect(result.piFilesWritten.sort()).toEqual(['auth.json', 'models.json']);
    expect(result.piFilesBackedUp).toEqual(['auth.json']);
    const backups = readdirSync(dir).filter((name) => name.startsWith('auth.json.backup-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]), 'utf8')).toBe('OLD');
  });

  it('apply ignores unknown pi filenames and stores only registered non-path settings', () => {
    const { service, writes } = fakeSettings({ agentDir: dir });
    const result = new ProvisionService(service).apply({
      piAgent: { 'evil.sh': 'rm -rf /' } as Record<string, string>,
      settings: {
        CURSOR_API_KEY: 'ck',
        NUNCIO_WORKSPACES_DIR: '/nope',
        TOTALLY_UNKNOWN: 'x',
      },
    });

    expect(existsSync(join(dir, 'evil.sh'))).toBe(false);
    expect(result.piFilesWritten).toEqual([]);
    expect(writes).toEqual([['CURSOR_API_KEY', 'ck']]);
    expect(result.settingsApplied).toEqual(['CURSOR_API_KEY']);
    expect(result.settingsSkipped.sort()).toEqual(['NUNCIO_WORKSPACES_DIR', 'TOTALLY_UNKNOWN']);
  });

  it('apply rejects oversized file content', () => {
    const { service } = fakeSettings({ agentDir: dir });
    const huge = 'x'.repeat(256 * 1024 + 1);
    expect(() => new ProvisionService(service).apply({ piAgent: { 'auth.json': huge } })).toThrow(
      BadRequestException,
    );
  });

  it('push collects, posts to the target, and returns the summary', async () => {
    writeFileSync(join(dir, 'auth.json'), '{"a":1}');
    const { service } = fakeSettings({ agentDir: dir, dbValues: { CURSOR_API_KEY: 'ck' } });
    const provision = new ProvisionService(service);

    const calls: Array<{ url: string; body: unknown }> = [];
    provision.fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({
          piFilesWritten: ['auth.json'],
          piFilesBackedUp: [],
          settingsApplied: ['CURSOR_API_KEY'],
          settingsSkipped: [],
        }),
        { status: 201 },
      );
    };

    const result = await provision.push('other-mac.ts.net:3000');
    expect(calls[0].url).toBe('http://other-mac.ts.net:3000/api/provision');
    expect(result.sent.piFiles).toEqual(['auth.json']);
    expect(result.applied.settingsApplied).toEqual(['CURSOR_API_KEY']);
  });

  it('push surfaces refusals and unreachable targets as 400s', async () => {
    const { service } = fakeSettings({ agentDir: dir });
    const provision = new ProvisionService(service);

    provision.fetchImpl = async () => new Response('nope', { status: 401 });
    await expect(provision.push('host:3000')).rejects.toThrow(/refused the provision \(401\)/);

    provision.fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(provision.push('host:3000')).rejects.toThrow(/Could not reach/);

    await expect(provision.push('ftp://x')).rejects.toThrow(/Invalid provision target/);
  });
});
