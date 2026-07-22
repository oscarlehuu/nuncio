import { describe, expect, it } from 'bun:test';
import { parseHubPath, resolveMachineTarget } from '../../../src/hub/hub-routing';

describe('parseHubPath', () => {
  it('splits a hub path into machine + downstream target path', () => {
    expect(parseHubPath('/m/oscar-workstation/api/sessions')).toEqual({
      machine: 'oscar-workstation',
      targetPath: '/api/sessions',
    });
    expect(parseHubPath('/m/mac.tailf0.ts.net/api/sessions/1/stream?since=5')).toEqual({
      machine: 'mac.tailf0.ts.net',
      targetPath: '/api/sessions/1/stream?since=5',
    });
  });

  it('defaults the target path to / when the machine root is requested', () => {
    expect(parseHubPath('/m/foo')).toEqual({ machine: 'foo', targetPath: '/' });
    expect(parseHubPath('/m/foo/')).toEqual({ machine: 'foo', targetPath: '/' });
  });

  it('returns null for non-hub paths', () => {
    expect(parseHubPath('/api/sessions')).toBeNull();
    expect(parseHubPath('/')).toBeNull();
    expect(parseHubPath('/m')).toBeNull();
    expect(parseHubPath('/m/')).toBeNull();
  });

  it('rejects machine segments with path-traversal or illegal chars', () => {
    expect(parseHubPath('/m/..%2f..%2fapi')).toBeNull();
    expect(parseHubPath('/m/ /api')).toBeNull();
  });

  for (const [label, path] of [
    ['raw parent segment', '/m/foo/api/webhooks/../sessions?since=4'],
    ['encoded parent segment', '/m/foo/api/webhooks/%2e%2e/sessions?since=4'],
    ['mixed-case encoded parent segment', '/m/foo/api/webhooks/.%2E/sessions?since=4'],
  ] as const) {
    it(`canonicalizes the ${label} before returning the forwarding path`, () => {
      expect(parseHubPath(path)).toEqual({
        machine: 'foo',
        targetPath: '/api/sessions?since=4',
      });
    });
  }

  for (const malformed of [
    '/m/%/api/sessions',
    '/m/%2/api/sessions',
    '/m/%GG/api/sessions',
    '/m/foo/api/%',
    '/m/foo/api/%2',
    '/m/foo/api/%GG',
    '/m/foo/api/%E0%A4%A',
  ]) {
    it(`rejects malformed percent encoding without throwing: ${malformed}`, () => {
      expect(() => parseHubPath(malformed)).not.toThrow();
      expect(parseHubPath(malformed)).toBeNull();
    });
  }

  it('preserves valid percent-encoded Unicode without changing path structure', () => {
    expect(parseHubPath('/m/foo/api/search/%E2%9C%93?q=%E2%9C%93')).toEqual({
      machine: 'foo',
      targetPath: '/api/search/%E2%9C%93?q=%E2%9C%93',
    });
  });

  it('rejects encoded or raw path separators that could be interpreted differently downstream', () => {
    expect(parseHubPath('/m/foo/api%2fsessions')).toBeNull();
    expect(parseHubPath('/m/foo/api%5csessions')).toBeNull();
    expect(parseHubPath('/m/foo\\api\\sessions')).toBeNull();
  });
});

describe('resolveMachineTarget (SSRF guard)', () => {
  const registry = new Map([
    ['oscar-workstation', 'http://100.105.188.11:3000'],
    ['mac', 'http://100.111.98.6:3000'],
  ]);

  it('resolves only machines present in the registry', () => {
    expect(resolveMachineTarget('oscar-workstation', registry)).toBe('http://100.105.188.11:3000');
    expect(resolveMachineTarget('mac', registry)).toBe('http://100.111.98.6:3000');
  });

  it('refuses any machine not in the registry — never builds an arbitrary URL', () => {
    expect(resolveMachineTarget('evil.example.com', registry)).toBeNull();
    expect(resolveMachineTarget('169.254.169.254', registry)).toBeNull();
    expect(resolveMachineTarget('', registry)).toBeNull();
    expect(resolveMachineTarget('localhost:22', registry)).toBeNull();
  });
});
