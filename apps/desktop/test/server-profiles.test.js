const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadProfiles,
  normalizeServerUrl,
  saveProfiles,
  serverNameFromUrl,
  upsertServer,
} = require('../src/server-profiles');

describe('normalizeServerUrl', () => {
  test('adds http:// when the scheme is missing and strips trailing slashes', () => {
    expect(normalizeServerUrl('oscars-macbook-pro.tail1.ts.net:3000')).toBe(
      'http://oscars-macbook-pro.tail1.ts.net:3000',
    );
    expect(normalizeServerUrl('http://host:3000/')).toBe('http://host:3000');
    expect(normalizeServerUrl('https://host:3000/base/')).toBe('https://host:3000/base');
  });

  test('rejects empty, non-http, and unparsable input', () => {
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('   ')).toBeNull();
    expect(normalizeServerUrl('ftp://host')).toBeNull();
    expect(normalizeServerUrl('http://')).toBeNull();
    expect(normalizeServerUrl(42)).toBeNull();
  });
});

describe('serverNameFromUrl', () => {
  test('uses the first hostname label', () => {
    expect(serverNameFromUrl('http://oscars-macbook-pro.tail1.ts.net:3000')).toBe(
      'oscars-macbook-pro',
    );
  });
});

describe('load/save/upsert', () => {
  test('returns defaults for a missing path or corrupt file', () => {
    expect(loadProfiles(null)).toEqual({ lastUsed: 'local', servers: [] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuncio-profiles-'));
    const file = path.join(dir, 'servers.json');
    fs.writeFileSync(file, '{not json');
    expect(loadProfiles(file)).toEqual({ lastUsed: 'local', servers: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('round-trips profiles and drops invalid entries on load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuncio-profiles-'));
    const file = path.join(dir, 'servers.json');

    let profiles = upsertServer({ lastUsed: 'local', servers: [] }, 'macbook.ts.net:3000');
    profiles = { ...profiles, lastUsed: 'http://macbook.ts.net:3000' };
    expect(saveProfiles(file, profiles)).toBe(true);

    const loaded = loadProfiles(file);
    expect(loaded.lastUsed).toBe('http://macbook.ts.net:3000');
    expect(loaded.servers).toEqual([{ name: 'macbook', url: 'http://macbook.ts.net:3000' }]);

    // Corrupt one entry + lastUsed; loader sanitizes.
    fs.writeFileSync(
      file,
      JSON.stringify({ lastUsed: 'ftp://nope', servers: [{ url: 'not a url' }, { url: 'host2:3000' }] }),
    );
    const sanitized = loadProfiles(file);
    expect(sanitized.lastUsed).toBe('local');
    expect(sanitized.servers).toEqual([{ name: 'host2', url: 'http://host2:3000' }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('upsertServer dedupes by url and keeps custom names', () => {
    let profiles = { lastUsed: 'local', servers: [] };
    profiles = upsertServer(profiles, 'http://a.ts.net:3000');
    profiles = upsertServer(profiles, 'a.ts.net:3000', 'Custom A');
    profiles = upsertServer(profiles, 'http://b.ts.net:3000');
    expect(profiles.servers).toEqual([
      { name: 'Custom A', url: 'http://a.ts.net:3000' },
      { name: 'b', url: 'http://b.ts.net:3000' },
    ]);
    // Invalid input is a no-op
    expect(upsertServer(profiles, 'ftp://x')).toEqual(profiles);
  });
});
