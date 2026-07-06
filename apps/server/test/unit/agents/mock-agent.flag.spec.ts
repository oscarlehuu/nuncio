import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import { AgentsModule } from '../../../src/agents/agents.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
type EmittedEvent = { type: string; payload: unknown; seq?: number; createdAt?: number };

/**
 * The Mock provider is a zero-credential fallback engine. It must be COMPLETELY
 * absent from a normal boot (no `mock` in the registry, `get('mock')` throws) and
 * only appear when the operator opts in with `NUNCIO_FORCE_MOCK=1`. That opt-in
 * is what the scripted level-5 UI smoke uses so it never needs real credentials.
 */
describe('MockAgentProvider gating (NUNCIO_FORCE_MOCK)', () => {
  let module: TestingModule;
  let dataDir: string;
  const priorFlag = process.env.NUNCIO_FORCE_MOCK;

  afterEach(async () => {
    if (module) await module.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    if (priorFlag === undefined) delete process.env.NUNCIO_FORCE_MOCK;
    else process.env.NUNCIO_FORCE_MOCK = priorFlag;
  });

  async function bootRegistry(): Promise<AgentRegistry> {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-mockflag-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule],
    }).compile();
    return module.get(AgentRegistry);
  }

  it('does NOT register mock when the flag is unset', async () => {
    delete process.env.NUNCIO_FORCE_MOCK;
    const registry = await bootRegistry();

    expect(() => registry.get('mock')).toThrow(BadRequestException);
    expect(registry.all().map((p) => p.id)).not.toContain('mock');
    expect((await registry.available()).map((p) => p.id)).not.toContain('mock');
  });

  it('does NOT register mock when the flag is a non-"1" value', async () => {
    process.env.NUNCIO_FORCE_MOCK = '0';
    const registry = await bootRegistry();

    expect(() => registry.get('mock')).toThrow(BadRequestException);
    expect(registry.all().map((p) => p.id)).not.toContain('mock');
  });

  it('registers an always-available mock when NUNCIO_FORCE_MOCK=1', async () => {
    process.env.NUNCIO_FORCE_MOCK = '1';
    const registry = await bootRegistry();

    const mock = registry.get('mock');
    expect(mock.id).toBe('mock');
    expect(await mock.isAvailable()).toBe(true);
    expect(registry.all().map((p) => p.id)).toContain('mock');
    expect((await registry.available()).map((p) => p.id)).toContain('mock');
  });

  it('streams a canned reply as deltas + a terminal assistant_message', async () => {
    process.env.NUNCIO_FORCE_MOCK = '1';
    const registry = await bootRegistry();
    const sessions = module.get(SessionsRepository);
    const events = module.get(EventsRepository);

    const created = sessions.create({
      id: 'mockflag-1',
      provider: 'mock',
      prompt: 'hello there',
    });

    const emitted: EmittedEvent[] = [];
    await registry.get('mock').run(created.id, 'hello there', {
      emit: (e) => emitted.push(e),
    });

    const persisted = events.list(created.id);
    const deltas = persisted.filter((e) => e.type === 'assistant_delta');
    const finalMsg = persisted.find((e) => e.type === 'assistant_message');

    expect(deltas.length).toBeGreaterThan(0);
    expect(finalMsg).toBeDefined();
    const finalText = (finalMsg?.payload as { text: string }).text;
    expect(finalText.length).toBeGreaterThan(0);
    // The concatenated deltas reconstruct the terminal message text.
    const streamed = deltas.map((e) => (e.payload as { delta: string }).delta).join('');
    expect(streamed).toBe(finalText);
    // Session reaches IDLE via the base orchestration.
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
  });
});
