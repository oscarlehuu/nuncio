import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

/**
 * Session-mode conformance at the session layer: a mode is accepted only when
 * the resolving provider advertises `capabilities.modes`, is rejected cleanly
 * (4xx) otherwise, and survives a re-read (the resume path reads the row). The
 * Mock provider stands in for the modes-capable engine; the simulated Cursor
 * provider is the modes-less one.
 */
describe('SessionsService session modes', () => {
  let module: TestingModule;
  let service: SessionsService;
  let dataDir: string;

  async function settle(id: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const status = service.get(id)?.status;
      if (status === 'IDLE' || status === 'ERROR') return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-modes-spec-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_FORCE_MOCK = '1';
    configureSimulatedCursorEnv();

    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, GitModule, SessionsPersistenceModule, AgentsModule, CursorLocalModule],
        providers: [SessionsService],
      }),
    ).compile();

    service = module.get(SessionsService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_FORCE_MOCK;
    delete process.env.CURSOR_API_KEY;
  });

  it('accepts a mode on a modes-capable provider and persists it', async () => {
    const created = await service.create({ prompt: 'debug this', provider: 'mock', mode: 'debug' });
    expect(created.mode).toBe('debug');
    await settle(created.id);
    // Re-read is the resume path: the mode column is the source of truth.
    expect(service.get(created.id)?.mode).toBe('debug');
  });

  it('defaults to no mode (normal agent) when omitted', async () => {
    const created = await service.create({ prompt: 'no mode', provider: 'mock' });
    expect(created.mode).toBeNull();
    await settle(created.id);
    expect(service.get(created.id)?.mode).toBeNull();
  });

  it('rejects a mode cleanly on a provider without the capability', async () => {
    await expect(
      service.create({ prompt: 'debug this', provider: 'cursor', mode: 'debug' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown mode string outright', async () => {
    await expect(
      // A bogus mode can arrive from the HTTP boundary; the create path must 4xx.
      service.create({ prompt: 'bogus', provider: 'mock', mode: 'wat' as 'debug' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
