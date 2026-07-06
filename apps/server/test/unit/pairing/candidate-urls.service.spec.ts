import { afterEach, describe, expect, it } from 'bun:test';
import { CandidateUrlsService } from '../../../src/pairing/candidate-urls.service';

const service = new CandidateUrlsService();

afterEach(() => {
  delete process.env.PORT;
});

describe('CandidateUrlsService', () => {
  it('always returns an object with url and hint arrays (never throws)', () => {
    const result = service.build();
    expect(Array.isArray(result.urls)).toBe(true);
    expect(Array.isArray(result.hints)).toBe(true);
  });

  it('builds LAN URLs on the configured port, skipping loopback/link-local/CGNAT ranges', () => {
    process.env.PORT = '4321';
    const result = service.build();
    for (const url of result.urls) {
      expect(url.startsWith('http://')).toBe(true);
      expect(url.endsWith(':4321')).toBe(true);
      // Excluded families must never surface.
      expect(url).not.toContain('127.0.0.1');
      expect(url).not.toContain('://169.254.');
      // CGNAT / tailnet 100.64/10 must be filtered.
      const host = url.slice('http://'.length, url.lastIndexOf(':'));
      const octets = host.split('.');
      if (octets[0] === '100') {
        const second = Number(octets[1]);
        expect(second >= 64 && second <= 127).toBe(false);
      }
    }
  });
});
