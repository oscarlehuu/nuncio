import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSettingDefinition } from '../../../src/settings/settings.registry';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

/**
 * The verify-feedback loop must be configured through the SETTINGS registry +
 * SettingsService.resolve (DB -> env -> default), NOT process.env directly — a
 * DB override has to beat an env var. These specs pin that contract so a
 * process.env-only shortcut cannot pass. RED until the keys + loop exist.
 */

const AUTO_STEER = 'NUNCIO_VERIFY_AUTO_STEER';
const MAX_ROUNDS = 'NUNCIO_VERIFY_MAX_ROUNDS';

function eventsOfType(events: SessionEvent[], type: string): SessionEvent[] {
  return events.filter((e) => e.type === type);
}

describe('verify-feedback settings — registry contract', () => {
  it('registers the auto-steer master switch as a boolean in the agents category', () => {
    const def = getSettingDefinition(AUTO_STEER);
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.providerId).toBeUndefined();
    expect(def!.type).toBe('boolean');
    expect(def!.envVar).toBe(AUTO_STEER);
  });

  it('registers the max-rounds setting with a default of 3', () => {
    const def = getSettingDefinition(MAX_ROUNDS);
    expect(def).toBeDefined();
    expect(def!.category).toBe('agents');
    expect(def!.providerId).toBeUndefined();
    expect(def!.envVar).toBe(MAX_ROUNDS);
    expect(def!.default).toBe('3');
  });
});

describe('verify-feedback settings — loop reads via SettingsService (DB beats env)', () => {
  let module: TestingModule;
  let service: SessionsService;
  let settings: SettingsService;
  let events: EventsRepository;
  let dataDir: string;
  let workspace: string;
  const prior: Record<string, string | undefined> = {};

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-vf-settings-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();

    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [
          DatabaseModule,
          SettingsModule,
          SessionsPersistenceModule,
          AgentsModule,
          GitModule,
          CursorLocalModule,
        ],
        providers: [SessionsService],
      }),
    ).compile();

    service = module.get(SessionsService);
    settings = module.get(SettingsService);
    events = module.get(EventsRepository);
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-vf-settings-ws-'));
    prior[AUTO_STEER] = process.env[AUTO_STEER];
    prior[MAX_ROUNDS] = process.env[MAX_ROUNDS];
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    try {
      settings.clear(AUTO_STEER);
      settings.clear(MAX_ROUNDS);
    } catch {
      // keys may not exist yet in the red phase
    }
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  function writeAlwaysFailScript(): void {
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), 'echo "RED" >&2\nexit 1\n');
  }

  async function waitForSettled(sessionId: string, timeoutMs = 10000): Promise<SessionEvent[]> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const all = events.list(sessionId);
      if (
        eventsOfType(all, 'verify_needs_attention').length > 0 ||
        all.some((e) => e.type === 'verify_result' && (e.payload as { ok?: boolean }).ok === true)
      ) {
        await new Promise((r) => setTimeout(r, 200));
        return events.list(sessionId);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return events.list(sessionId);
  }

  it('a DB auto-steer=1 overrides an env auto-steer=0 (DB wins)', async () => {
    process.env[AUTO_STEER] = '0'; // env says off
    settings.set(AUTO_STEER, '1'); // DB says on — must win
    settings.set(MAX_ROUNDS, '2');
    writeAlwaysFailScript();

    const session = await service.create({ prompt: 'db over env', provider: 'cursor', workspace });
    const all = await waitForSettled(session.id);
    // Loop ran because the DB override enabled it despite the env var.
    expect(eventsOfType(all, 'verify_retry').length).toBeGreaterThan(0);
  }, 20000);

  it('accepts the boolean spelling "true" for the auto-steer switch', async () => {
    settings.set(AUTO_STEER, 'true');
    settings.set(MAX_ROUNDS, '1');
    writeAlwaysFailScript();

    const session = await service.create({ prompt: 'bool true', provider: 'cursor', workspace });
    const all = await waitForSettled(session.id);
    expect(eventsOfType(all, 'verify_needs_attention').length).toBe(1);
  }, 20000);

  it('clamps a negative max-rounds to the default of 3', async () => {
    settings.set(AUTO_STEER, '1');
    settings.set(MAX_ROUNDS, '-5');
    writeAlwaysFailScript();

    const session = await service.create({ prompt: 'negative rounds', provider: 'cursor', workspace });
    const all = await waitForSettled(session.id, 15000);
    // -5 must clamp to the default 3, never loop unbounded.
    expect(eventsOfType(all, 'verify_retry').length).toBe(3);
    expect(eventsOfType(all, 'verify_needs_attention').length).toBe(1);
  }, 25000);

  it('clamps a non-numeric max-rounds to the default of 3', async () => {
    settings.set(AUTO_STEER, '1');
    settings.set(MAX_ROUNDS, 'lots');
    writeAlwaysFailScript();

    const session = await service.create({ prompt: 'garbage rounds', provider: 'cursor', workspace });
    const all = await waitForSettled(session.id, 15000);
    expect(eventsOfType(all, 'verify_retry').length).toBe(3);
  }, 25000);
});
