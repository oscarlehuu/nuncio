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
import { ChipsService } from '../../../src/chips/chips.service';
import { spawnTaskRef } from '../../../src/agents/pi-engine/spawn-task-tool';
import type { ProposeChipInput } from '../../../src/chips/chips.types';

/**
 * Session chips (spawn-task) lifecycle over the attention queue: propose →
 * dedup, tap (act) → child session + terminal, dismiss (user/agent) → terminal,
 * and the capability gate + un-retriggerability that keep an acted/dismissed
 * chip from re-opening.
 */
describe('ChipsService', () => {
  let module: TestingModule;
  let dataDir: string;
  let chips: ChipsService;
  let now = 1_000;

  let capable: boolean;
  const sessionsById = new Map<string, SessionDto>();
  let createCalls: Array<Record<string, unknown>>;

  const sourceSession = {
    id: 'src',
    provider: 'pi',
    model: 'pi:default',
    projectPath: '/repos/x',
    workspace: '/repos/x',
  } as unknown as SessionDto;

  const propose = (over: Partial<ProposeChipInput> = {}) =>
    chips.propose({
      sourceSessionId: over.sourceSessionId ?? 'src',
      title: over.title ?? 'Remove the dead retry path in relay.ts',
      tldr: over.tldr ?? 'The legacy retry branch is unreachable after the queue refactor.',
      prompt:
        over.prompt ??
        'In apps/server/src/relay/relay.service.ts delete the unreachable legacyMode retry branch and its helper, then update the relay unit test.',
      ...(over.cwd !== undefined ? { cwd: over.cwd } : {}),
    });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-chips-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [AttentionRepository, AttentionService],
    }).compile();
    const attention = module.get(AttentionService);
    const repo = module.get(AttentionRepository);
    now = 1_000;
    attention.clock = { now: () => now };

    capable = true;
    sessionsById.clear();
    sessionsById.set('src', sourceSession);
    createCalls = [];

    const fakeSessions = {
      registerChipHandler: () => {},
      get: (id: string) => sessionsById.get(id) ?? null,
      create: async (dto: Record<string, unknown>) => {
        const child = {
          id: `child-${createCalls.length + 1}`,
          status: 'RUNNING',
          ...dto,
        } as unknown as SessionDto;
        sessionsById.set(child.id, child);
        createCalls.push(dto);
        return child;
      },
    } as unknown as SessionsService;

    const fakeAgents = {
      resolveForSession: (s: SessionDto) => ({
        id: s.provider ?? 'pi',
        capabilities: { spawnTask: capable },
      }),
    } as unknown as AgentRegistry;

    chips = new ChipsService(attention, repo, fakeSessions, fakeAgents);
    chips.clock = { now: () => now };
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  describe('propose', () => {
    it('materializes an open, proposed chip carrying the source session + ref', () => {
      const chip = propose();
      expect(chip.status).toBe('proposed');
      expect(chip.sourceSessionId).toBe('src');
      expect(chip.projectPath).toBe('/repos/x');
      expect(chip.ref).toBe(spawnTaskRef(chip.title, chip.prompt));
      expect(chips.listForSession('src')).toHaveLength(1);
    });

    it('dedups an identical title+prompt from the same session (one open chip)', () => {
      const first = propose();
      const second = propose();
      expect(second.id).toBe(first.id);
      expect(chips.listForSession('src')).toHaveLength(1);
    });

    it('keeps chips distinct across source sessions with the same title+prompt', () => {
      sessionsById.set('other', { ...sourceSession, id: 'other' } as unknown as SessionDto);
      propose();
      propose({ sourceSessionId: 'other' });
      expect(chips.listForSession('src')).toHaveLength(1);
      expect(chips.listForSession('other')).toHaveLength(1);
    });

    it('rejects a proposal from an engine without the spawn-task capability (conformance)', () => {
      capable = false;
      expect(() => propose()).toThrow(BadRequestException);
      expect(chips.listForSession('src')).toHaveLength(0);
    });

    it('rejects a proposal whose source session is gone', () => {
      expect(() => propose({ sourceSessionId: 'ghost' })).toThrow(NotFoundException);
    });

    it('rejects a too-short (non self-contained) prompt at the boundary', () => {
      expect(() => propose({ prompt: 'fix it' })).toThrow(BadRequestException);
    });
  });

  describe('act', () => {
    it('spins the chip into a lineage child inheriting engine + model, then resolves it', async () => {
      const chip = propose();
      const { chip: acted, session } = await chips.act(chip.id);
      expect(acted.status).toBe('acted');
      expect(acted.childSessionId).toBe(session.id);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]).toMatchObject({
        prompt: chip.prompt,
        provider: 'pi',
        model: 'pi:default',
        parentSessionId: 'src',
      });
      // A resolved chip leaves the session-view row.
      expect(chips.listForSession('src')).toHaveLength(0);
    });

    it('is idempotent on a double-tap — one child, not two', async () => {
      const chip = propose();
      const first = await chips.act(chip.id);
      const second = await chips.act(chip.id);
      expect(second.session.id).toBe(first.session.id);
      expect(createCalls).toHaveLength(1);
    });

    it('cannot spawn a chip that was already dismissed', async () => {
      const chip = propose();
      chips.dismiss(chip.id, { by: 'user' });
      await expect(chips.act(chip.id)).rejects.toThrow(BadRequestException);
    });

    it('rejects an unknown chip id', async () => {
      await expect(chips.act('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('dismiss', () => {
    it('resolves the chip and records who dismissed it', () => {
      const chip = propose();
      const dismissed = chips.dismiss(chip.id, { by: 'user', reason: 'not worth it' });
      expect(dismissed.status).toBe('dismissed');
      expect(dismissed.dismissedBy).toBe('user');
      expect(dismissed.dismissReason).toBe('not worth it');
      expect(chips.listForSession('src')).toHaveLength(0);
    });

    it('is idempotent on an already-dismissed chip', () => {
      const chip = propose();
      chips.dismiss(chip.id, { by: 'user' });
      expect(() => chips.dismiss(chip.id, { by: 'agent' })).not.toThrow();
    });

    it('dismissByRef withdraws the open chip for a ref, and no-ops on an unknown ref', () => {
      const chip = propose();
      expect(chips.dismissByRef('src', chip.ref, { by: 'agent' })?.status).toBe('dismissed');
      expect(chips.dismissByRef('src', 'deadbeef', { by: 'agent' })).toBeNull();
    });
  });

  describe('un-retriggerable after terminal', () => {
    it('does not re-open an acted chip on an identical re-propose', async () => {
      const chip = propose();
      await chips.act(chip.id);
      const reproposed = propose();
      expect(reproposed.status).toBe('acted');
      expect(chips.listForSession('src')).toHaveLength(0);
    });

    it('does not re-open a dismissed chip on an identical re-propose', () => {
      const chip = propose();
      chips.dismiss(chip.id, { by: 'user' });
      const reproposed = propose();
      expect(reproposed.status).toBe('dismissed');
      expect(chips.listForSession('src')).toHaveLength(0);
    });
  });

  describe('onSpawnTaskEvent seam', () => {
    it('proposes a chip from a spawn_task_proposed event', () => {
      chips.onSpawnTaskEvent('src', {
        type: 'spawn_task_proposed',
        payload: {
          title: 'Delete the stale changelog draft',
          tldr: 'A leftover draft still references the removed PWA path.',
          prompt:
            'Remove apps/web/CHANGELOG.draft.md — it documents the deleted service worker path and confuses release notes.',
        },
      });
      expect(chips.listForSession('src')).toHaveLength(1);
    });

    it('dismisses a chip from a spawn_task_dismissed event by ref', () => {
      const chip = propose();
      chips.onSpawnTaskEvent('src', {
        type: 'spawn_task_dismissed',
        payload: { id: chip.ref, reason: 'handled inline' },
      });
      expect(chips.listForSession('src')).toHaveLength(0);
      expect(chips.get(chip.id)?.status).toBe('dismissed');
    });
  });
});
