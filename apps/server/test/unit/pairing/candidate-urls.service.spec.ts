import { afterEach, describe, expect, it } from 'bun:test';
import { CandidateUrlsService } from '../../../src/pairing/candidate-urls.service';
import type {
  FunnelResult,
  ServeResult,
  TailscaleService,
} from '../../../src/tailscale/tailscale.service';
import type { TailscaleStatusDto } from '../../../src/tailscale/tailscale.types';

interface FakeTailscaleOptions {
  running?: boolean;
  dnsName?: string | null;
  serve?: ServeResult;
  funnel?: FunnelResult;
}

function fakeTailscale(options: FakeTailscaleOptions = {}): TailscaleService {
  const { running = false, dnsName = null, serve = true, funnel = { ok: true } } = options;
  const status: TailscaleStatusDto = {
    installed: running,
    running,
    autoTrust: true,
    tailnet: running ? 'oscar.lehuu@gmail.com' : null,
    self:
      running && dnsName !== null
        ? { hostName: 'mac', dnsName, ips: ['100.94.230.13'], os: 'macOS', loginName: 'x@' }
        : null,
    peers: [],
  };
  return {
    status: async () => status,
    enableServe: async (_port: number): Promise<ServeResult> => serve,
    enableFunnel: async (_port: number): Promise<FunnelResult> => funnel,
  } as unknown as TailscaleService;
}

function makeService(
  addresses: string[],
  tailscale: TailscaleService = fakeTailscale(),
): CandidateUrlsService {
  const service = new CandidateUrlsService(tailscale);
  service.networkInterfacesFn = () => ({
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
    en0: addresses.map(
      (address) => ({ address, family: 'IPv4', internal: false }) as never,
    ),
  });
  return service;
}

afterEach(() => {
  delete process.env.PORT;
});

describe('CandidateUrlsService LAN enumeration', () => {
  it('always returns url and hint arrays and never throws', async () => {
    const service = makeService([]);
    const result = await service.build();
    expect(Array.isArray(result.urls)).toBe(true);
    expect(Array.isArray(result.hints)).toBe(true);
  });

  it('builds LAN URLs on the configured port', async () => {
    process.env.PORT = '4321';
    const service = makeService(['192.168.1.20']);
    const result = await service.build();
    expect(result.urls).toContain('http://192.168.1.20:4321');
  });

  it('defaults to port 3000 when PORT is unset', async () => {
    const service = makeService(['192.168.1.20']);
    const result = await service.build();
    expect(result.urls[0]).toBe('http://192.168.1.20:3000');
  });

  it('excludes loopback, link-local (169.254/16) and CGNAT (100.64/10) addresses', async () => {
    const service = makeService(['192.168.1.20', '169.254.1.1', '100.100.0.5', '10.0.0.4']);
    const result = await service.build();
    const hosts = result.urls.map((url) => url.slice('http://'.length, url.lastIndexOf(':')));
    expect(hosts).toContain('192.168.1.20');
    expect(hosts).toContain('10.0.0.4');
    expect(hosts).not.toContain('169.254.1.1');
    expect(hosts).not.toContain('100.100.0.5');
  });

  it('keeps CGNAT-range boundaries: 100.63 and 100.128 are LAN, 100.64-100.127 are not', async () => {
    const service = makeService(['100.63.0.1', '100.64.0.1', '100.127.255.1', '100.128.0.1']);
    const result = await service.build();
    const hosts = result.urls.map((url) => url.slice('http://'.length, url.lastIndexOf(':')));
    expect(hosts).toContain('100.63.0.1');
    expect(hosts).toContain('100.128.0.1');
    expect(hosts).not.toContain('100.64.0.1');
    expect(hosts).not.toContain('100.127.255.1');
  });

  it('caps LAN URLs at 4 even with more interfaces', async () => {
    const service = makeService([
      '192.168.1.1',
      '192.168.1.2',
      '192.168.1.3',
      '192.168.1.4',
      '192.168.1.5',
      '10.0.0.9',
    ]);
    const result = await service.build();
    expect(result.urls.filter((u) => u.startsWith('http://'))).toHaveLength(4);
  });
});

describe('CandidateUrlsService MagicDNS + hints', () => {
  it('offline: no https URL, offline hint present', async () => {
    const service = makeService(['192.168.1.20'], fakeTailscale({ running: false }));
    const result = await service.build();
    expect(result.urls.some((u) => u.startsWith('https://'))).toBe(false);
    expect(result.hints).toContain('Tailscale offline — pairing works on this Wi-Fi only');
  });

  it('running + serve ok + funnel ok: https URL present, no hints', async () => {
    const service = makeService(
      ['192.168.1.20'],
      fakeTailscale({ running: true, dnsName: 'mac.tailnet.ts.net' }),
    );
    const result = await service.build();
    expect(result.urls).toContain('https://mac.tailnet.ts.net');
    expect(result.hints).toEqual([]);
  });

  it('strips a trailing dot from the MagicDNS name', async () => {
    const service = makeService(
      ['192.168.1.20'],
      fakeTailscale({ running: true, dnsName: 'mac.tailnet.ts.net.' }),
    );
    const result = await service.build();
    expect(result.urls).toContain('https://mac.tailnet.ts.net');
  });

  it('serve failure: no https URL, serve-failed hint (not the offline one — tailnet is up)', async () => {
    const service = makeService(
      ['192.168.1.20'],
      fakeTailscale({ running: true, dnsName: 'mac.tailnet.ts.net', serve: false }),
    );
    const result = await service.build();
    expect(result.urls.some((u) => u.startsWith('https://'))).toBe(false);
    expect(result.hints).toEqual(['Tailscale Serve setup failed — pairing works on this Wi-Fi only']);
  });

  it('funnel ACL-denied: https URL kept, funnel hint present', async () => {
    const service = makeService(
      ['192.168.1.20'],
      fakeTailscale({
        running: true,
        dnsName: 'mac.tailnet.ts.net',
        funnel: { ok: false, reason: 'acl' },
      }),
    );
    const result = await service.build();
    expect(result.urls).toContain('https://mac.tailnet.ts.net');
    expect(result.hints).toContain(
      'Tailscale Funnel unavailable — remote access needs Tailscale on the phone',
    );
  });

  it('funnel generic failure: same funnel hint (phone still needs Tailscale)', async () => {
    const service = makeService(
      ['192.168.1.20'],
      fakeTailscale({
        running: true,
        dnsName: 'mac.tailnet.ts.net',
        funnel: { ok: false, reason: 'error' },
      }),
    );
    const result = await service.build();
    expect(result.urls).toContain('https://mac.tailnet.ts.net');
    expect(result.hints).toContain(
      'Tailscale Funnel unavailable — remote access needs Tailscale on the phone',
    );
  });

  it('status() rejection degrades to LAN-only + offline hint (never throws)', async () => {
    const rejecting = {
      status: async () => {
        throw new Error('tailscale wedged');
      },
      enableServe: async () => true,
      enableFunnel: async () => ({ ok: true }),
    } as unknown as TailscaleService;
    const service = makeService(['192.168.1.20'], rejecting);

    const result = await service.build();
    expect(result.urls).toEqual(['http://192.168.1.20:3000']);
    expect(result.hints).toContain('Tailscale offline — pairing works on this Wi-Fi only');
  });

  it('enableServe rejection degrades to LAN-only, no https URL (never throws)', async () => {
    const rejecting = {
      status: async () => ({
        installed: true,
        running: true,
        autoTrust: true,
        tailnet: 't',
        self: { hostName: 'mac', dnsName: 'mac.ts.net', ips: [], os: 'macOS', loginName: 'x@' },
        peers: [],
      }),
      enableServe: async () => {
        throw new Error('serve hung');
      },
      enableFunnel: async () => ({ ok: true }),
    } as unknown as TailscaleService;
    const service = makeService(['192.168.1.20'], rejecting);

    const result = await service.build();
    expect(result.urls.some((u) => u.startsWith('https://'))).toBe(false);
    expect(result.urls).toContain('http://192.168.1.20:3000');
    expect(result.hints).toContain('Tailscale Serve setup failed — pairing works on this Wi-Fi only');
  });

  it('does not hang: a slow tailscale still resolves build() within a bound', async () => {
    const slow = {
      status: async () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                installed: false,
                running: false,
                autoTrust: false,
                tailnet: null,
                self: null,
                peers: [],
              }),
            50,
          ),
        ),
      enableServe: async () => false,
      enableFunnel: async () => ({ ok: false, reason: 'error' as const }),
    } as unknown as TailscaleService;
    const service = makeService(['192.168.1.20'], slow);

    const started = Date.now();
    const result = await service.build();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.urls).toContain('http://192.168.1.20:3000');
  });
});
