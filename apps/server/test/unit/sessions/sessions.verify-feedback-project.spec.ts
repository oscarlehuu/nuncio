import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';
import { ProjectsModule } from '../../../src/projects/projects.module';
import { ProjectsRepository } from '../../../src/projects/projects.repository';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

/**
 * Integration: the rung-1 verify-feedback loop must consult the PER-PROJECT
 * override for the session's project_path, resolved above the global setting.
 * RED until sessions.service reads the ProjectDefaultsResolver. A project with
 * verifyAutoSteer='on' loops even when the global setting is off; 'off' never
 * loops even when global is on; 'inherit'/no-row behaves exactly as today.
 */

const AUTO = 'NUNCIO_VERIFY_AUTO_STEER';
const ROUNDS = 'NUNCIO_VERIFY_MAX_ROUNDS';

function eventsOfType(events: SessionEvent[], type: string): SessionEvent[] {
  return events.filter((e) => e.type === type);
}

describe('verify-feedback loop honours the per-project auto-steer override', () => {
  let module: TestingModule;
  let service: SessionsService;
  let projects: ProjectsRepository;
  let settings: SettingsService;
  let events: EventsRepository;
  let dataDir: string;
  let workspace: string;
  const prior: Record<string, string | undefined> = {};

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-vf-project-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [
          DatabaseModule,
          SettingsModule,
          ProjectsModule,
          SessionsPersistenceModule,
          AgentsModule,
          GitModule,
          CursorLocalModule,
        ],
        providers: [SessionsService],
      }),
    ).compile();
    service = module.get(SessionsService);
    projects = module.get(ProjectsRepository);
    settings = module.get(SettingsService);
    events = module.get(EventsRepository);
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-vf-project-ws-'));
    // create() treats projectPath as a git repo (lists branches); make the
    // workspace a real repo so a project-scoped session can be created.
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    prior[AUTO] = process.env[AUTO];
    prior[ROUNDS] = process.env[ROUNDS];
    delete process.env[AUTO];
    delete process.env[ROUNDS];
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    try {
      projects.delete(workspace);
      settings.clear(AUTO);
      settings.clear(ROUNDS);
    } catch {
      /* red phase */
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

  function writeAlwaysFailUnique(): void {
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    const counter = join(workspace, '.nuncio', 'run-count');
    writeFileSync(
      join(workspace, '.nuncio', 'verify'),
      [
        '#!/bin/sh',
        `N=$(cat "${counter}" 2>/dev/null || echo 0)`,
        'N=$((N + 1))',
        `echo "$N" > "${counter}"`,
        'echo "RED project #$N" >&2',
        'exit 1',
        '',
      ].join('\n'),
    );
  }

  async function waitForSettled(sessionId: string, timeoutMs = 12000): Promise<SessionEvent[]> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const all = events.list(sessionId);
      if (
        eventsOfType(all, 'verify_needs_attention').length > 0 ||
        all.some((e) => e.type === 'verify_result' && (e.payload as { ok?: boolean }).ok === true)
      ) {
        await new Promise((r) => setTimeout(r, 250));
        return events.list(sessionId);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return events.list(sessionId);
  }

  it("project 'on' loops even though the global setting is off", async () => {
    settings.set(AUTO, '0'); // global OFF
    settings.set(ROUNDS, '2');
    projects.upsert({ path: workspace, verifyAutoSteer: 'on' });
    writeAlwaysFailUnique();

    // The session is scoped to the project by projectPath = workspace.
    const session = await service.create({
      prompt: 'project on',
      provider: 'cursor',
      workspace,
      projectPath: workspace,
    });
    const all = await waitForSettled(session.id);
    expect(eventsOfType(all, 'verify_retry').length).toBeGreaterThan(0);
    expect(eventsOfType(all, 'verify_needs_attention').length).toBe(1);
  }, 25000);

  it("project 'off' never loops even though the global setting is on", async () => {
    settings.set(AUTO, '1'); // global ON
    projects.upsert({ path: workspace, verifyAutoSteer: 'off' });
    writeAlwaysFailUnique();

    const session = await service.create({
      prompt: 'project off',
      provider: 'cursor',
      workspace,
      projectPath: workspace,
    });
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (events.list(session.id).some((e) => e.type === 'verify_result')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 400));
    const all = events.list(session.id);
    expect(eventsOfType(all, 'verify_result')).toHaveLength(1);
    expect(eventsOfType(all, 'verify_retry')).toHaveLength(0);
  }, 25000);

  it("project 'inherit' with global on loops exactly as today", async () => {
    settings.set(AUTO, '1');
    settings.set(ROUNDS, '2');
    projects.upsert({ path: workspace, verifyAutoSteer: 'inherit' });
    writeAlwaysFailUnique();

    const session = await service.create({
      prompt: 'project inherit',
      provider: 'cursor',
      workspace,
      projectPath: workspace,
    });
    const all = await waitForSettled(session.id);
    expect(eventsOfType(all, 'verify_needs_attention').length).toBe(1);
  }, 25000);

  it('a session with no project config row behaves exactly as the global setting (off)', async () => {
    settings.set(AUTO, '0');
    writeAlwaysFailUnique();
    // No projects.upsert — unconfigured project path.
    const session = await service.create({
      prompt: 'no project row',
      provider: 'cursor',
      workspace,
      projectPath: workspace,
    });
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (events.list(session.id).some((e) => e.type === 'verify_result')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(eventsOfType(events.list(session.id), 'verify_retry')).toHaveLength(0);
  }, 25000);

  it('the per-project max-rounds override caps the loop', async () => {
    settings.set(AUTO, '0'); // global off; project turns it on
    settings.set(ROUNDS, '5'); // global rounds high
    projects.upsert({ path: workspace, verifyAutoSteer: 'on', verifyMaxRounds: 2 });
    writeAlwaysFailUnique();

    const session = await service.create({
      prompt: 'project rounds cap',
      provider: 'cursor',
      workspace,
      projectPath: workspace,
    });
    const all = await waitForSettled(session.id);
    // Project's 2 caps it, not the global 5.
    expect(eventsOfType(all, 'verify_retry').length).toBe(2);
    expect((eventsOfType(all, 'verify_needs_attention')[0]!.payload as { rounds?: number }).rounds).toBe(2);
  }, 25000);

  async function waitForVerifyResult(sessionId: string, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = events.list(sessionId).find((e) => e.type === 'verify_result');
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  }

  it('a project-only verifyCommand actually runs on turn end (no .nuncio/verify, no global)', async () => {
    // The gap: with only a project verifyCommand set, verification must still run.
    settings.set(AUTO, '0'); // loop off — just prove the command runs
    projects.upsert({ path: workspace, verifyCommand: 'echo project-cmd-ran; exit 3' });
    // Deliberately NO .nuncio/verify script and NO global NUNCIO_VERIFY_COMMAND.

    const session = await service.create({
      prompt: 'project verify only',
      provider: 'cursor',
      workspace,
      projectPath: workspace,
    });
    const result = await waitForVerifyResult(session.id);
    expect(result).toBeDefined();
    expect(result!.payload).toMatchObject({ ok: false, exitCode: 3 });
  }, 25000);

  it('project verifyCommand override wins over a .nuncio/verify script', async () => {
    settings.set(AUTO, '0');
    // A .nuncio/verify that would PASS...
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), 'exit 0\n');
    // ...but the project override FAILS, and must win.
    projects.upsert({ path: workspace, verifyCommand: 'exit 7' });

    const session = await service.create({
      prompt: 'override beats file',
      provider: 'cursor',
      workspace,
      projectPath: workspace,
    });
    const result = await waitForVerifyResult(session.id);
    expect(result!.payload).toMatchObject({ ok: false, exitCode: 7 });
  }, 25000);

  it('with no project override, .nuncio/verify still wins over the global setting (unchanged)', async () => {
    settings.set(AUTO, '0');
    settings.set('NUNCIO_VERIFY_COMMAND', 'exit 9'); // global would fail
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), 'exit 0\n'); // file passes
    projects.upsert({ path: workspace }); // row exists, no verify override

    const session = await service.create({
      prompt: 'file beats global',
      provider: 'cursor',
      workspace,
      projectPath: workspace,
    });
    const result = await waitForVerifyResult(session.id);
    expect(result!.payload).toMatchObject({ ok: true, exitCode: 0 });
    settings.clear('NUNCIO_VERIFY_COMMAND');
  }, 25000);
});
