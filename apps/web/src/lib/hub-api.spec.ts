import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentMachine, fetchHubMachines, machineApiBase, machineHref } from './hub-api';

describe('hub-api helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('currentMachine', () => {
    it('extracts the machine segment from a hub base', () => {
      expect(currentMachine('/m/oscar-workstation')).toBe('oscar-workstation');
      expect(currentMachine('/m/oscars-macbook-pro.tailf08532.ts.net')).toBe(
        'oscars-macbook-pro.tailf08532.ts.net',
      );
    });

    it('returns null at the hub root', () => {
      expect(currentMachine('')).toBeNull();
      expect(currentMachine('/')).toBeNull();
      expect(currentMachine('/session/1')).toBeNull();
    });
  });

  describe('machineHref', () => {
    it('builds a trailing-slash hub path', () => {
      expect(machineHref('oscar-workstation')).toBe('/m/oscar-workstation/');
    });
  });

  describe('machineApiBase', () => {
    it('returns empty for missing or invalid machine ids', () => {
      expect(machineApiBase(null)).toBe('');
      expect(machineApiBase(undefined)).toBe('');
      expect(machineApiBase('has space')).toBe('');
    });

    it('returns an origin-absolute machine API base for valid ids', () => {
      vi.stubGlobal('window', {
        location: { origin: 'https://hub.ts.net' },
      });
      expect(machineApiBase('oscar-workstation')).toBe(
        'https://hub.ts.net/m/oscar-workstation',
      );
    });
  });

  describe('fetchHubMachines', () => {
    it('queries the origin hub machines endpoint', async () => {
      vi.stubGlobal('window', {
        location: { origin: 'https://hub.ts.net' },
      });
      const payload = { hubMode: true, machines: [] };
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => payload,
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchHubMachines()).resolves.toEqual(payload);
      expect(fetchMock).toHaveBeenCalledWith('https://hub.ts.net/api/hub/machines');
    });

    it('throws on non-OK responses', async () => {
      vi.stubGlobal('window', {
        location: { origin: 'https://hub.ts.net' },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 503 }),
      );

      await expect(fetchHubMachines()).rejects.toThrow(
        'Failed to load hub machines (503)',
      );
    });
  });
});
