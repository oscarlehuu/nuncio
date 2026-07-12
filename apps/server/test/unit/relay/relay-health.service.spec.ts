import { describe, expect, it, jest } from 'bun:test';
import { RelayHealthService } from '../../../src/relay/relay-health.service';

describe('RelayHealthService', () => {
  it('measures real LAN and MagicDNS health paths plus read-only Funnel configuration', async () => {
    const tailscale = {
      status: jest.fn(async () => ({
        installed: true, running: true,
        self: { dnsName: 'studio.tailnet.ts.net.' },
      })),
      probeFunnel: jest.fn(async () => ({ status: 'up' as const })),
    };
    const service = new RelayHealthService(tailscale as never);
    service.networkInterfacesFn = () => ({ en0: [{
      address: '192.168.1.20', family: 'IPv4', internal: false,
    } as never] });
    service.fetchFn = jest.fn(async () => ({ ok: true, status: 200 })) as never;

    const result = await service.probeAll();

    expect(service.fetchFn).toHaveBeenCalledWith(
      'http://192.168.1.20:3000/api/health', expect.objectContaining({ signal: expect.anything() }),
    );
    expect(service.fetchFn).toHaveBeenCalledWith(
      'https://studio.tailnet.ts.net/api/health', expect.objectContaining({ signal: expect.anything() }),
    );
    expect(result.lan.status).toBe('up');
    expect(result.tailnet.status).toBe('up');
    expect(result.funnel.status).toBe('up');
    expect(typeof result.tailnet.latencyMs).toBe('number');
  });
});
