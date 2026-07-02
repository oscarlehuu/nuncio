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
