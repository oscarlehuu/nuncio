import { describe, it, expect } from 'vitest';
import { resolveBasePath, withBase, toWsUrl, rewriteFetchInput } from './api-base';

describe('resolveBasePath', () => {
  it('extracts the /m/<machine> prefix from a hub path', () => {
    expect(resolveBasePath('/m/oscar-workstation/session/123')).toBe('/m/oscar-workstation');
    expect(resolveBasePath('/m/oscar-workstation')).toBe('/m/oscar-workstation');
    expect(resolveBasePath('/m/oscar-workstation/')).toBe('/m/oscar-workstation');
    expect(resolveBasePath('/m/oscars-macbook-pro.tailf08532.ts.net/settings')).toBe(
      '/m/oscars-macbook-pro.tailf08532.ts.net',
    );
  });

  it('returns empty string for non-hub (direct) paths', () => {
    expect(resolveBasePath('/')).toBe('');
    expect(resolveBasePath('/session/123')).toBe('');
    expect(resolveBasePath('/settings')).toBe('');
  });

  it('treats a bare or machine-less /m as non-hub (no SSRF-shaped garbage)', () => {
    expect(resolveBasePath('/m')).toBe('');
    expect(resolveBasePath('/m/')).toBe('');
  });

  it('rejects a machine segment with illegal characters', () => {
    // Only hostname chars are valid; anything else is not a machine prefix.
    expect(resolveBasePath('/m/has space/x')).toBe('');
    expect(resolveBasePath('/m/..%2Fetc/x')).toBe('');
    expect(resolveBasePath('/m/a/b/c')).toBe('/m/a');
  });
});

describe('withBase', () => {
  it('prepends the base to an /api path', () => {
    expect(withBase('/api/sessions', '/m/foo')).toBe('/m/foo/api/sessions');
    expect(withBase('/api/sessions', '')).toBe('/api/sessions');
  });

  it('preserves query strings', () => {
    expect(withBase('/api/sessions/1/stream?since=5', '/m/foo')).toBe(
      '/m/foo/api/sessions/1/stream?since=5',
    );
  });
});

describe('rewriteFetchInput', () => {
  it('prefixes leading /api string URLs with the base', () => {
    expect(rewriteFetchInput('/api/sessions', '/m/foo')).toBe('/m/foo/api/sessions');
    expect(rewriteFetchInput('/api/sessions?x=1', '/m/foo')).toBe('/m/foo/api/sessions?x=1');
  });

  it('leaves everything else untouched', () => {
    expect(rewriteFetchInput('/api/sessions', '')).toBe('/api/sessions');
    expect(rewriteFetchInput('/assets/app.js', '/m/foo')).toBe('/assets/app.js');
    expect(rewriteFetchInput('https://example.com/api/x', '/m/foo')).toBe(
      'https://example.com/api/x',
    );
    // Already-based paths are not double-prefixed.
    expect(rewriteFetchInput('/m/foo/api/x', '/m/foo')).toBe('/m/foo/api/x');
  });

  it('passes non-string inputs (Request/URL) through unchanged', () => {
    const req = new Request('http://x/api/y');
    expect(rewriteFetchInput(req, '/m/foo')).toBe(req);
  });
});

describe('toWsUrl', () => {
  it('turns an http origin + based path into a ws url', () => {
    expect(toWsUrl('http://hub:3000', '/api/terminal', '/m/foo')).toBe(
      'ws://hub:3000/m/foo/api/terminal',
    );
    expect(toWsUrl('https://hub.ts.net', '/api/terminal', '/m/foo')).toBe(
      'wss://hub.ts.net/m/foo/api/terminal',
    );
    expect(toWsUrl('http://localhost:3000', '/api/terminal', '')).toBe(
      'ws://localhost:3000/api/terminal',
    );
  });
});
