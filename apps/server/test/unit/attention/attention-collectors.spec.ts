import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { AttentionRepository } from '../../../src/attention/attention.repository';
import { AttentionService } from '../../../src/attention/attention.service';
import { AttentionCollectors } from '../../../src/attention/attention-collectors';
import { LoopsService } from '../../../src/loops/loops.service';
import {
  notifySessionEventHooks,
} from '../../../src/sessions/domain/session-event-hooks';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';
import type { LoopDto } from '../../../src/loops/loops.types';

/**
 * The rung-1/2 signal collectors (sub-phase A). Verifies the ADDITIVE wiring:
 * existing session events + loop status drive attention items, with dedup +
 * auto-resolve. A minimal LoopsService fake supplies loop status for the
 * broken-loop collector + probe.
 */
class FakeLoops {
  loops: LoopDto[] = [];
  list(): LoopDto[] {
    return this.loops;
  }
  findById(id: string): LoopDto | null {
    return this.loops.find((l) => l.id === id) ?? null;
  }
}

function event(type: string, payload: unknown, seq = 1): SessionEvent {
  return { seq, type, payload, createdAt: 0 };
}

function loop(over: Partial<LoopDto> = {}): LoopDto {
  return {
    id: over.id ?? 'loop-1',
    name: over.name ?? null,
    goal: over.goal ?? 'nightly',
    scheduleId: 's',
    maxRunsPerDay: 5,
    maxConsecutiveFailures: 3,
    stop: null,
    escalation: 'needs-attention',
    projectPath: over.projectPath ?? '/repos/x',
    engine: null,
    model: null,
    status: over.status ?? 'broken',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('AttentionCollectors', () => {
  let module: TestingModule;
  let collectors: AttentionCollectors;
  let attention: AttentionService;
  let fakeLoops: FakeLoops;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-attention-collect-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    fakeLoops = new FakeLoops();
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        AttentionRepository,
        AttentionService,
        AttentionCollectors,
        { provide: LoopsService, useValue: fakeLoops },
      ],
    }).compile();
    attention = module.get(AttentionService);
    collectors = module.get(AttentionCollectors);
    collectors.onModuleInit(); // registers the event hook + probes + boot sweep
  });

  afterEach(async () => {
    collectors.onModuleDestroy();
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('raises a permission item on user_input_requested (existing event, no new type)', () => {
    notifySessionEventHooks('sess-1', event('user_input_requested', { requestId: 'r1', title: 'Approve?' }));
    const items = attention.list().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('permission');
    expect(items[0]!.subjectId).toBe('sess-1:r1');
  });

  it('resolves the permission item when the input is resolved', () => {
    notifySessionEventHooks('sess-1', event('user_input_requested', { requestId: 'r1' }));
    notifySessionEventHooks('sess-1', event('user_input_resolved', { requestId: 'r1' }, 2));
    expect(attention.list().items.filter((i) => i.kind === 'permission')).toHaveLength(0);
  });

  it('does not stack duplicate permission items for the same request', () => {
    notifySessionEventHooks('sess-1', event('user_input_requested', { requestId: 'r1' }));
    notifySessionEventHooks('sess-1', event('user_input_requested', { requestId: 'r1' }, 2));
    expect(attention.list().items.filter((i) => i.kind === 'permission')).toHaveLength(1);
  });

  it('raises a verify-dead item on verify_needs_attention', () => {
    notifySessionEventHooks('sess-9', event('verify_needs_attention', {}));
    const items = attention.list().items;
    expect(items.some((i) => i.kind === 'verify-dead' && i.subjectId === 'sess-9')).toBe(true);
  });

  it('sweep raises a tripped-breaker item for a broken loop', () => {
    fakeLoops.loops = [loop({ id: 'loop-1', status: 'broken' })];
    collectors.sweep();
    expect(attention.list().items.some((i) => i.kind === 'tripped-breaker' && i.subjectId === 'loop-1')).toBe(true);
  });

  it('a broken loop that resumed auto-resolves its item on the next sweep', () => {
    fakeLoops.loops = [loop({ id: 'loop-1', status: 'broken' })];
    collectors.sweep();
    expect(attention.list().items.some((i) => i.subjectId === 'loop-1')).toBe(true);
    // The loop resumed → the probe reports the condition cleared.
    fakeLoops.loops = [loop({ id: 'loop-1', status: 'active' })];
    collectors.sweep();
    expect(attention.list().items.some((i) => i.subjectId === 'loop-1')).toBe(false);
  });
});
