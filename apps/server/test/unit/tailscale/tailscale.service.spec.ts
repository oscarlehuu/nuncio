import { describe, expect, it } from 'bun:test';
import {
  TailscaleService,
  isTailscaleAddress,
  normalizeRemoteAddress,
  type ExecFn,
} from '../../../src/tailscale/tailscale.service';
import type { SettingsService } from '../../../src/settings/settings.service';

const STATUS_JSON = JSON.stringify({
  BackendState: 'Running',
  CurrentTailnet: { Name: 'oscar.lehuu@gmail.com' },
  Self: {
    HostName: 'oscar-m5pro',
    DNSName: 'oscar-m5pro.tailf08532.ts.net.',
    TailscaleIPs: ['100.94.230.13'],
    OS: 'macOS',
    UserID: 111,
    Online: true,
  },
  User: {
    '111': { LoginName: 'oscar.lehuu@' },
    '222': { LoginName: 'other.user@' },
  },
  Peer: {
    nodekeyA: {
      HostName: 'oscar-workstation',
      DNSName: 'oscar-workstation.tailf08532.ts.net.',
      TailscaleIPs: ['100.105.188.11'],
      OS: 'linux',
      UserID: 111,
      Online: true,
    },
    nodekeyB: {
      HostName: 'lelinux',
      DNSName: 'lelinux.tail4c9027.ts.net.',
      TailscaleIPs: ['100.64.94.44'],
      OS: 'linux',
      UserID: 222,
      Online: false,
    },
  },
});

function whoisJson(userId: number): string {
  return JSON.stringify({ Node: { ID: 1 }, UserProfile: { ID: userId, LoginName: 'x@' } });
}

function settingsWith(value: string | undefined): SettingsService {
  return { resolve: () => value } as unknown as SettingsService;
}

interface FakeCliOptions {
  installed?: boolean;
  whoisUserIds?: Record<string, number>;
}

function fakeExec(calls: string[][], options: FakeCliOptions = {}): ExecFn {
  const { installed = true, whoisUserIds = {} } = options;
  return async (argv: string[]) => {
    calls.push(argv);
    if (!installed) return { ok: false, stdout: '' };
    const command = argv[1];
    if (command === 'version') return { ok: true, stdout: '1.98.3' };
    if (command === 'status') return { ok: true, stdout: STATUS_JSON };
    if (command === 'whois') {
      const ip = argv[3];
      const userId = whoisUserIds[ip];
      return userId === undefined
        ? { ok: false, stdout: '' }
        : { ok: true, stdout: whoisJson(userId) };
    }
    return { ok: false, stdout: '' };
  };
}

function serviceWith(exec: ExecFn, settingValue: string | undefined = '1'): TailscaleService {
  const service = new TailscaleService(settingsWith(settingValue));
  service.exec = exec;
  return service;
}

describe('address helpers', () => {
  it('normalizes v4-mapped addresses', () => {
    expect(normalizeRemoteAddress('::ffff:100.64.0.9')).toBe('100.64.0.9');
    expect(normalizeRemoteAddress('100.64.0.9')).toBe('100.64.0.9');
    expect(normalizeRemoteAddress(undefined)).toBeNull();
  });

  it('recognizes only tailnet ranges', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(true);
    expect(isTailscaleAddress('100.127.255.254')).toBe(true);
    expect(isTailscaleAddress('100.63.0.1')).toBe(false);
    expect(isTailscaleAddress('100.128.0.1')).toBe(false);
    expect(isTailscaleAddress('192.168.1.5')).toBe(false);
    expect(isTailscaleAddress('fd7a:115c:a1e0::e37:bc0b')).toBe(true);
    expect(isTailscaleAddress('fd00::1')).toBe(false);
  });
});

describe('TailscaleService.status', () => {
  it('reports not installed when no CLI candidate responds', async () => {
    const service = serviceWith(fakeExec([], { installed: false }));
    const status = await service.status();
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.peers).toEqual([]);
  });

  it('parses self, tailnet, and peers with sameUser flags', async () => {
    const service = serviceWith(fakeExec([]));
    const status = await service.status();

    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.tailnet).toBe('oscar.lehuu@gmail.com');
    expect(status.self?.hostName).toBe('oscar-m5pro');
    expect(status.self?.dnsName).toBe('oscar-m5pro.tailf08532.ts.net');
    expect(status.self?.loginName).toBe('oscar.lehuu@');

    expect(status.peers).toHaveLength(2);
    const workstation = status.peers.find((p) => p.hostName === 'oscar-workstation');
    const foreign = status.peers.find((p) => p.hostName === 'lelinux');
    expect(workstation?.sameUser).toBe(true);
    expect(workstation?.online).toBe(true);
    expect(foreign?.sameUser).toBe(false);
    expect(foreign?.loginName).toBe('other.user@');
    // online peers sort first
    expect(status.peers[0].hostName).toBe('oscar-workstation');
  });

  it('reflects the auto-trust setting', async () => {
    expect((await serviceWith(fakeExec([]), '0').status()).autoTrust).toBe(false);
    expect((await serviceWith(fakeExec([]), '1').status()).autoTrust).toBe(true);
    expect((await serviceWith(fakeExec([]), undefined).status()).autoTrust).toBe(true);
  });
});

describe('TailscaleService.isTrustedRemote', () => {
  it('trusts a same-account tailnet peer', async () => {
    const service = serviceWith(fakeExec([], { whoisUserIds: { '100.105.188.11': 111 } }));
    expect(await service.isTrustedRemote('100.105.188.11')).toBe(true);
    expect(await service.isTrustedRemote('::ffff:100.105.188.11')).toBe(true);
  });

  it('rejects a peer owned by a different account', async () => {
    const service = serviceWith(fakeExec([], { whoisUserIds: { '100.64.94.44': 222 } }));
    expect(await service.isTrustedRemote('100.64.94.44')).toBe(false);
  });

  it('rejects when whois fails or the address is unknown to tailscaled', async () => {
    const service = serviceWith(fakeExec([], { whoisUserIds: {} }));
    expect(await service.isTrustedRemote('100.64.0.99')).toBe(false);
  });

  it('never spawns the CLI for non-tailnet addresses or when the toggle is off', async () => {
    const calls: string[][] = [];
    const offService = serviceWith(fakeExec(calls, { whoisUserIds: { '100.64.0.9': 111 } }), '0');
    expect(await offService.isTrustedRemote('100.64.0.9')).toBe(false);
    expect(calls).toHaveLength(0);

    const onCalls: string[][] = [];
    const onService = serviceWith(fakeExec(onCalls));
    expect(await onService.isTrustedRemote('192.168.1.5')).toBe(false);
    expect(await onService.isTrustedRemote('203.0.113.7')).toBe(false);
    expect(onCalls).toHaveLength(0);
  });

  it('caches whois lookups per address', async () => {
    const calls: string[][] = [];
    const service = serviceWith(fakeExec(calls, { whoisUserIds: { '100.105.188.11': 111 } }));
    await service.isTrustedRemote('100.105.188.11');
    await service.isTrustedRemote('100.105.188.11');
    await service.isTrustedRemote('100.105.188.11');
    const whoisCalls = calls.filter((argv) => argv[1] === 'whois');
    expect(whoisCalls).toHaveLength(1);
  });

  it('degrades to untrusted when the CLI is missing', async () => {
    const service = serviceWith(fakeExec([], { installed: false }));
    expect(await service.isTrustedRemote('100.105.188.11')).toBe(false);
  });
});
