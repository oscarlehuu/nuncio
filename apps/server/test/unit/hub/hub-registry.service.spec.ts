import { describe, expect, it } from 'bun:test';
import { HubRegistryService, machineName } from '../../../src/hub/hub-registry.service';
import type { TailscaleService } from '../../../src/tailscale/tailscale.service';
import type { TailscaleStatusDto } from '../../../src/tailscale/tailscale.types';

const STATUS: TailscaleStatusDto = {
  installed: true,
  running: true,
  autoTrust: true,
  tailnet: 'oscar@example.com',
  self: {
    hostName: 'LC3Y34J661X',
    dnsName: 'oscar-m5pro.tailf0.ts.net',
    ips: ['100.94.230.13'],
    os: 'macOS',
    loginName: 'oscar@',
  },
  peers: [
    {
      hostName: 'oscar-workstation',
      dnsName: 'oscar-workstation.tailf0.ts.net',
      ips: ['100.105.188.11'],
      os: 'linux',
      online: true,
      loginName: 'oscar@',
      sameUser: true,
    },
    {
      hostName: 'macbook',
      dnsName: 'oscars-macbook-pro.tailf0.ts.net',
      ips: ['100.111.98.6'],
      os: 'macOS',
      online: false, // offline peer — not probed, not in registry
      loginName: 'oscar@',
      sameUser: true,
    },
    {
      hostName: 'friend-box',
      dnsName: 'friend-box.tail9.ts.net',
      ips: ['100.64.94.44'],
      os: 'linux',
      online: true,
      loginName: 'friend@',
      sameUser: false, // other account — excluded even if running nuncio
    },
  ],
};

function fakeTailscale(status: TailscaleStatusDto): TailscaleService {
  return { status: async () => status } as unknown as TailscaleService;
}

/** Probe returns ok only for the listed dnsNames (they run nuncio). */
function fakeProbe(nuncioHosts: string[]): (url: string) => Promise<boolean> {
  return async (url: string) => nuncioHosts.some((host) => url.includes(host));
}

describe('machineName', () => {
  it('uses the MagicDNS first label', () => {
    expect(machineName('oscar-m5pro.tailf0.ts.net')).toBe('oscar-m5pro');
    expect(machineName('macbook')).toBe('macbook');
    expect(machineName('')).toBe('');
  });
});

describe('HubRegistryService.discover', () => {
  it('includes self plus same-user online peers that answer the nuncio health probe', async () => {
    const service = new HubRegistryService(fakeTailscale(STATUS));
    service.probe = fakeProbe(['oscar-workstation.tailf0.ts.net']);

    const machines = await service.discover();
    const names = machines.map((m) => m.name).sort();
    expect(names).toEqual(['oscar-m5pro', 'oscar-workstation']);

    const self = machines.find((m) => m.name === 'oscar-m5pro');
    expect(self?.self).toBe(true);
    expect(self?.origin).toBe('http://oscar-m5pro.tailf0.ts.net:3000');

    const ws = machines.find((m) => m.name === 'oscar-workstation');
    expect(ws?.self).toBe(false);
    expect(ws?.origin).toBe('http://oscar-workstation.tailf0.ts.net:3000');
  });

  it('excludes offline peers, other-account peers, and peers without nuncio', async () => {
    const service = new HubRegistryService(fakeTailscale(STATUS));
    // Probe would say yes to everything, but online/sameUser filters apply first.
    service.probe = fakeProbe([
      'oscar-workstation.tailf0.ts.net',
      'oscars-macbook-pro.tailf0.ts.net',
      'friend-box.tail9.ts.net',
    ]);
    const machines = await service.discover();
    const names = machines.map((m) => m.name).sort();
    expect(names).toEqual(['oscar-m5pro', 'oscar-workstation']);
  });

  it('drops an online same-user peer that does not answer the health probe', async () => {
    const service = new HubRegistryService(fakeTailscale(STATUS));
    service.probe = fakeProbe([]); // nobody runs nuncio
    const machines = await service.discover();
    // self is always included (it is the hub); the peer is dropped.
    expect(machines.map((m) => m.name)).toEqual(['oscar-m5pro']);
  });

  it('returns only self when Tailscale is not running', async () => {
    const down: TailscaleStatusDto = { ...STATUS, running: false, peers: [] };
    const service = new HubRegistryService(fakeTailscale(down));
    service.probe = fakeProbe([]);
    const machines = await service.discover();
    expect(machines.map((m) => m.name)).toEqual(['oscar-m5pro']);
  });
});

describe('HubRegistryService.registryMap (SSRF source of truth)', () => {
  it('maps discovered machine names to their origins', async () => {
    const service = new HubRegistryService(fakeTailscale(STATUS));
    service.probe = fakeProbe(['oscar-workstation.tailf0.ts.net']);
    const map = await service.registryMap();
    expect(map.get('oscar-workstation')).toBe('http://oscar-workstation.tailf0.ts.net:3000');
    expect(map.get('oscar-m5pro')).toBe('http://oscar-m5pro.tailf0.ts.net:3000');
    expect(map.has('friend-box')).toBe(false);
  });
});
