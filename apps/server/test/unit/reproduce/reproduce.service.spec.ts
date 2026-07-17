import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { AttentionRepository } from '../../../src/attention/attention.repository';
import { AttentionService } from '../../../src/attention/attention.service';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { SessionDto } from '../../../src/sessions/domain/sessions.types';
import { ReproduceService } from '../../../src/reproduce/reproduce.service';
import { buildMarkFixedSteer, buildProceedSteer } from '../../../src/reproduce/reproduce-steer';
import { LOG_CAP_BYTES } from '../../../src/reproduce/reproduce.types';

/**
 * Reproduction-gate lifecycle over the attention queue: request → open (waiting),
 * log capture (bounded), Proceed/Mark-Fixed → resume via steer + terminal, plus
 * the capability gate and durable-through-resume behavior.
 */
describe('ReproduceService', () => {
  let module: TestingModule;
  let dataDir: string;
  let attention: AttentionService;
  let repo: AttentionRepository;
  let reproduce: ReproduceService;
  let now = 1_000;

  let capable: boolean;
  const sessionsById = new Map<string, SessionDto>();
  let steerCalls: Array<{ id: string; message: string; origin?: string }>;

  const session = {
    id: 'src',
    provider: 'pi',
    model: 'pi:default',
    projectPath: '/repos/x',
    workspace: '/repos/x',
  } as unknown as SessionDto;

  const request = (ref = 'ref-1', steps = ['run the repro', 'check the PID']) =>
    reproduce.request({ sessionId: 'src', ref, steps });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-reproduce-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [AttentionRepository, AttentionService],
    }).compile();
    attention = module.get(AttentionService);
    repo = module.get(AttentionRepository);
    now = 1_000;
    attention.clock = { now: () => now };

    capable = true;
    sessionsById.clear();
    sessionsById.set('src', session);
    steerCalls = [];

    const fakeSessions = {
      registerReproduceHandler: () => {},
      get: (id: string) => sessionsById.get(id) ?? null,
      steerInBackground: (id: string, message: string, _f?: unknown, _a?: unknown, origin?: string) => {
        steerCalls.push({ id, message, origin });
      },
    } as unknown as SessionsService;

    const fakeAgents = {
      resolveForSession: (s: SessionDto) => ({
        id: s.provider ?? 'pi',
        capabilities: { reproduceGate: capable },
      }),
    } as unknown as AgentRegistry;

    reproduce = new ReproduceService(attention, repo, fakeSessions, fakeAgents);
    reproduce.clock = { now: () => now };
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  describe('request', () => {
    it('materializes an open, requested gate carrying steps + ref', () => {
      const gate = request();
      expect(gate.status).toBe('requested');
      expect(gate.sessionId).toBe('src');
      expect(gate.ref).toBe('ref-1');
      expect(gate.steps).toEqual(['run the repro', 'check the PID']);
      expect(gate.logCount).toBe(0);
      expect(reproduce.listForSession('src')).toHaveLength(1);
    });

    it('rejects a request from an engine without the reproduce capability (conformance)', () => {
      capable = false;
      expect(() => request()).toThrow(BadRequestException);
      expect(reproduce.listForSession('src')).toHaveLength(0);
    });

    it('rejects a request whose session is gone', () => {
      sessionsById.delete('src');
      expect(() => request()).toThrow(NotFoundException);
    });

    it('keeps successive cycles distinct — resolving one never suppresses the next', () => {
      const first = request('ref-1');
      reproduce.proceed(first.id); // resolves cycle 1
      const second = request('ref-2'); // a fresh cycle on the same session
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('requested');
      expect(reproduce.listForSession('src')).toHaveLength(1);
    });
  });

  describe('appendLogs', () => {
    it('appends non-empty lines and bumps the counter', () => {
      const gate = request();
      const updated = reproduce.appendLogs(gate.id, ['line one', '  ', 'line two']);
      expect(updated.logCount).toBe(2);
    });

    it('ignores an all-blank batch (counter unchanged)', () => {
      const gate = request();
      const updated = reproduce.appendLogs(gate.id, ['   ', '\n', '']);
      expect(updated.logCount).toBe(0);
    });

    it('caps at LOG_CAP_BYTES — the breaching line is dropped, prefix kept, gate usable', () => {
      const gate = request();
      const big = 'x'.repeat(LOG_CAP_BYTES - 10);
      const afterFirst = reproduce.appendLogs(gate.id, [big]);
      expect(afterFirst.logCount).toBe(1);
      // A second line would breach the cap → dropped; the gate keeps working.
      const afterSecond = reproduce.appendLogs(gate.id, ['this line does not fit within the cap']);
      expect(afterSecond.logCount).toBe(1);
      // And the gate can still be resolved.
      expect(reproduce.proceed(gate.id).status).toBe('proceeded');
    });

    it('rejects logs on an already-resolved gate', () => {
      const gate = request();
      reproduce.proceed(gate.id);
      expect(() => reproduce.appendLogs(gate.id, ['late log'])).toThrow(BadRequestException);
    });
  });

  describe('proceed / markFixed', () => {
    it('proceed resumes the session with the collected logs, then resolves terminal', () => {
      const gate = request();
      reproduce.appendLogs(gate.id, ['CHROME PID 4242 still alive']);
      const resolved = reproduce.proceed(gate.id);
      expect(resolved.status).toBe('proceeded');
      expect(steerCalls).toHaveLength(1);
      expect(steerCalls[0]!.id).toBe('src');
      expect(steerCalls[0]!.message).toContain('CHROME PID 4242 still alive');
      expect(steerCalls[0]!.origin).toBe('reproduce-gate');
      expect(reproduce.listForSession('src')).toHaveLength(0);
    });

    it('markFixed resumes with the sentinel-sweep instruction, then resolves terminal', () => {
      const gate = request();
      const resolved = reproduce.markFixed(gate.id);
      expect(resolved.status).toBe('fixed');
      expect(steerCalls[0]!.message).toContain('// nuncio-debug');
      expect(reproduce.listForSession('src')).toHaveLength(0);
    });

    it('rejects proceed / markFixed on an already-resolved gate (double-tap safe)', () => {
      const gate = request();
      reproduce.proceed(gate.id);
      expect(() => reproduce.proceed(gate.id)).toThrow(BadRequestException);
      expect(() => reproduce.markFixed(gate.id)).toThrow(BadRequestException);
      // Only the first resume fired.
      expect(steerCalls).toHaveLength(1);
    });

    it('rejects an unknown gate id', () => {
      expect(reproduce.get('nope')).toBeNull();
      expect(() => reproduce.proceed('nope')).toThrow(NotFoundException);
    });
  });

  describe('onReproduceEvent seam', () => {
    it('materializes a gate from a reproduce_requested event', () => {
      reproduce.onReproduceEvent('src', {
        type: 'reproduce_requested',
        payload: { ref: 'evt-1', steps: ['run it'], logsHint: 'stderr' },
      });
      const open = reproduce.listForSession('src');
      expect(open).toHaveLength(1);
      expect(open[0]!.ref).toBe('evt-1');
    });

    it('drops a malformed event (no ref / no steps) without raising a gate', () => {
      reproduce.onReproduceEvent('src', { type: 'reproduce_requested', payload: { ref: '', steps: [] } });
      reproduce.onReproduceEvent('src', { type: 'reproduce_requested', payload: {} });
      reproduce.onReproduceEvent('src', { type: 'not_a_reproduce_event', payload: { ref: 'x', steps: ['y'] } });
      expect(reproduce.listForSession('src')).toHaveLength(0);
    });
  });

  describe('durable through resume', () => {
    it('a fresh service over the same store still sees the open gate', () => {
      const gate = request();
      // Re-read is the resume path: the attention row is the source of truth.
      const revived = new ReproduceService(
        attention,
        repo,
        { registerReproduceHandler: () => {}, get: () => session } as unknown as SessionsService,
        { resolveForSession: () => ({ id: 'pi', capabilities: { reproduceGate: true } }) } as unknown as AgentRegistry,
      );
      const open = revived.listForSession('src');
      expect(open).toHaveLength(1);
      expect(open[0]!.id).toBe(gate.id);
    });
  });

  describe('steer message builders', () => {
    it('proceed steer echoes captured logs, mark-fixed steer names the sentinel', () => {
      const withLogs = buildProceedSteer({
        ref: 'r',
        sessionId: 's',
        steps: ['x'],
        logsHint: null,
        logs: ['boom at line 12'],
        logBytes: 15,
        status: 'requested',
      });
      expect(withLogs).toContain('boom at line 12');
      expect(buildMarkFixedSteer()).toContain('// nuncio-debug');
    });
  });
});
