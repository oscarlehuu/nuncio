import { beforeEach, describe, expect, it } from 'bun:test';
import { InfraChecks } from '../../../../src/attention/heartbeat/infra-checks';

/**
 * Layer 1 infra self-check (rung 3 sub-phase B) — RED until implemented.
 * Deterministic via injected clock + seam fakes. Boundaries: absent ≠ invalid
 * credential; zombie age is STRICTLY greater than T; a hung probe is isolated.
 */
describe('InfraChecks', () => {
  let checks: InfraChecks;
  const NOW = 10_000_000;

  beforeEach(() => {
    checks = new InfraChecks();
    checks.clock = { now: () => NOW };
    checks.zombieAgeMs = 30 * 60 * 1000; // 30 min
    checks.checkTimeoutMs = 50;
    checks.connectedForges = async () => [];
    checks.runningSessions = () => [];
  });

  describe('credential validity', () => {
    it('an invalid/expiring credential (probe rejects) raises an item', async () => {
      checks.connectedForges = async () => [
        { id: 'github', probe: async () => { throw new Error('401'); } },
      ];
      const results = await checks.checkCredentials();
      const item = results.find((r) => r.subjectId === 'forge:github');
      expect(item).toBeDefined();
      expect(item!.ok).toBe(false);
      expect(item!.kind).toBe('credential-expiring');
    });

    it('a valid credential (probe resolves) yields an OK result (auto-resolve)', async () => {
      checks.connectedForges = async () => [{ id: 'github', probe: async () => {} }];
      const results = await checks.checkCredentials();
      const item = results.find((r) => r.subjectId === 'forge:github');
      expect(item!.ok).toBe(true);
    });

    it('an ABSENT credential is not probed → NO result (unconfigured ≠ broken)', async () => {
      // connectedForges only ever yields CONNECTED forges; an absent one is omitted.
      checks.connectedForges = async () => [];
      expect(await checks.checkCredentials()).toHaveLength(0);
    });

    it('a hung credential probe times out as a FAILED result, not a wedge', async () => {
      checks.connectedForges = async () => [
        { id: 'slowlab', probe: () => new Promise<void>(() => {}) }, // never resolves
      ];
      const results = await checks.checkCredentials();
      const item = results.find((r) => r.subjectId === 'forge:slowlab');
      expect(item!.ok).toBe(false); // timed out → treated as failing, bounded
    });
  });

  describe('zombie sessions', () => {
    it('a RUNNING session with last-event age STRICTLY > T is a zombie', () => {
      checks.runningSessions = () => [
        { id: 's-old', projectPath: '/x', lastEventAt: NOW - checks.zombieAgeMs - 1 },
      ];
      const results = checks.checkZombieSessions();
      const item = results.find((r) => r.subjectId === 'session:s-old');
      expect(item).toBeDefined();
      expect(item!.ok).toBe(false);
      expect(item!.kind).toBe('zombie-session');
    });

    it('a session exactly AT the threshold is NOT a zombie (strict boundary)', () => {
      checks.runningSessions = () => [
        { id: 's-edge', projectPath: null, lastEventAt: NOW - checks.zombieAgeMs },
      ];
      const zombies = checks.checkZombieSessions().filter((r) => !r.ok);
      expect(zombies).toHaveLength(0);
    });

    it('a healthy RUNNING session (recent event) is not flagged', () => {
      checks.runningSessions = () => [
        { id: 's-live', projectPath: null, lastEventAt: NOW - 1_000 },
      ];
      expect(checks.checkZombieSessions().filter((r) => !r.ok)).toHaveLength(0);
    });
  });

  describe('run() aggregates every check', () => {
    it('returns credential + zombie results together', async () => {
      checks.connectedForges = async () => [
        { id: 'github', probe: async () => { throw new Error('401'); } },
      ];
      checks.runningSessions = () => [
        { id: 's-old', projectPath: null, lastEventAt: NOW - checks.zombieAgeMs - 1 },
      ];
      const results = await checks.run();
      expect(results.some((r) => r.kind === 'credential-expiring' && !r.ok)).toBe(true);
      expect(results.some((r) => r.kind === 'zombie-session' && !r.ok)).toBe(true);
    });
  });
});
