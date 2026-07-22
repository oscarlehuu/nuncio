import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentToolsModule } from '../../../src/agents/tools/agent-tools.module';
import { AgentToolRegistry } from '../../../src/agents/tools/agent-tool-registry';
import { DatabaseService } from '../../../src/db/database.service';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SettingsRepository } from '../../../src/settings/persistence/settings.repository';
import { TasksModule } from '../../../src/tasks/tasks.module';
import { TasksRepository } from '../../../src/tasks/tasks.repository';

// Level-3 wiring: the orchestration tools reach AgentToolRegistry.forSession —
// the same value that flows into AgentRunContext.tools — gated by the setting.
describe('orchestration tools wiring', () => {
  let module: TestingModule;
  let registry: AgentToolRegistry;
  let settings: SettingsRepository;
  let sessions: SessionsRepository;
  let tasks: TasksRepository;
  let database: DatabaseService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-orch-wiring-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    delete process.env.NUNCIO_ORCHESTRATION_TOOLS;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, TasksModule, AgentToolsModule],
    }).compile();
    registry = module.get(AgentToolRegistry);
    settings = module.get(SettingsRepository);
    sessions = module.get(SessionsRepository);
    tasks = module.get(TasksRepository);
    database = module.get(DatabaseService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  function toolNames(sessionId: string, projectPath: string | null): string[] {
    return registry.forSession({ sessionId, projectPath }).tools.map((t) => t.name);
  }

  it('off (default) → only the default-on record-fact tool is present', () => {
    settings.delete('NUNCIO_ORCHESTRATION_TOOLS');
    settings.delete('NUNCIO_FACT_RECORDING');
    const s = sessions.create({ prompt: 'p', projectPath: '/repo' });
    expect(toolNames(s.id, '/repo').filter((n) => n.startsWith('nuncio_'))).toEqual([
      'nuncio_record_project_fact',
    ]);
  });

  it('off + NUNCIO_FACT_RECORDING=off → no nuncio_* tools at all', () => {
    settings.delete('NUNCIO_ORCHESTRATION_TOOLS');
    settings.set('NUNCIO_FACT_RECORDING', 'off');
    try {
      const s = sessions.create({ prompt: 'p', projectPath: '/repo' });
      expect(toolNames(s.id, '/repo').filter((n) => n.startsWith('nuncio_'))).toEqual([]);
    } finally {
      settings.delete('NUNCIO_FACT_RECORDING');
    }
  });

  it('read → the four read tools arrive alongside browser tools', () => {
    settings.set('NUNCIO_ORCHESTRATION_TOOLS', 'read');
    const s = sessions.create({ prompt: 'p', projectPath: '/repo' });
    const names = toolNames(s.id, '/repo');
    expect(names).toContain('nuncio_list_sessions');
    expect(names).toContain('nuncio_read_session');
    expect(names).toContain('nuncio_list_tasks');
    expect(names).toContain('nuncio_get_task_result');
    expect(names).not.toContain('nuncio_enqueue_task');
    // Browser tools still present (merge, not replace).
    expect(names.some((n) => n.startsWith('browser_'))).toBe(true);
  });

  it('read-write → enqueue tool also arrives', () => {
    settings.set('NUNCIO_ORCHESTRATION_TOOLS', 'read-write');
    const s = sessions.create({ prompt: 'p', projectPath: '/repo' });
    expect(toolNames(s.id, '/repo')).toContain('nuncio_enqueue_task');
  });

  it('a live nuncio_list_sessions call returns only same-project rows', async () => {
    settings.set('NUNCIO_ORCHESTRATION_TOOLS', 'read');
    const here = sessions.create({ prompt: 'caller', projectPath: '/proj-a' });
    sessions.create({ prompt: 'sibling', projectPath: '/proj-a' });
    sessions.create({ prompt: 'foreign', projectPath: '/proj-b' });

    const tool = registry
      .forSession({ sessionId: here.id, projectPath: '/proj-a' })
      .tools.find((t) => t.name === 'nuncio_list_sessions')!;
    const res = await tool.execute({});
    const rows = (res as { structuredContent: Array<{ id: string }> }).structuredContent;
    const projectPaths = rows.map((r) => sessions.findById(r.id)?.projectPath);
    expect(projectPaths.every((p) => p === '/proj-a')).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('read tools hide retired Crew sessions and tasks', async () => {
    settings.set('NUNCIO_ORCHESTRATION_TOOLS', 'read');
    const here = sessions.create({ prompt: 'caller', projectPath: '/proj-a' });
    const legacySession = sessions.create({ prompt: 'legacy Crew member', projectPath: '/proj-a' });
    database.db.prepare("UPDATE sessions SET verify_owner = 'crew' WHERE id = ?").run(legacySession.id);

    const legacyTask = tasks.create({
      prompt: 'legacy Crew task',
      parentSessionId: here.id,
      projectPath: '/proj-a',
    });
    database.db
      .prepare(
        `UPDATE tasks
         SET execution_kind = 'crew-member', verify_owner = 'crew', status = 'DONE',
             outcome_json = '{}', finished_at = updated_at
         WHERE id = ?`,
      )
      .run(legacyTask.id);

    const tools = registry.forSession({ sessionId: here.id, projectPath: '/proj-a' }).tools;
    const listSessions = tools.find((tool) => tool.name === 'nuncio_list_sessions')!;
    const readSession = tools.find((tool) => tool.name === 'nuncio_read_session')!;
    const getTaskResult = tools.find((tool) => tool.name === 'nuncio_get_task_result')!;

    const listed = (await listSessions.execute({})) as {
      structuredContent: Array<{ id: string }>;
    };
    expect(listed.structuredContent.map((row) => row.id)).not.toContain(legacySession.id);

    const sessionResult = (await readSession.execute({ sessionId: legacySession.id })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(sessionResult.isError).toBe(true);
    expect(sessionResult.content[0]?.text).toContain('not found');

    const taskResult = (await getTaskResult.execute({ taskId: legacyTask.id })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(taskResult.isError).toBe(true);
    expect(taskResult.content[0]?.text).toContain('not found');
  });

  it('a tool built while enabled refuses after the setting flips to off (F3)', async () => {
    settings.set('NUNCIO_ORCHESTRATION_TOOLS', 'read');
    const s = sessions.create({ prompt: 'p', projectPath: '/repo' });
    const tool = registry
      .forSession({ sessionId: s.id, projectPath: '/repo' })
      .tools.find((t) => t.name === 'nuncio_list_sessions')!;
    // Works now...
    expect(((await tool.execute({})) as { isError?: boolean }).isError).toBeUndefined();
    // ...refuses after a mid-session flip to off, even on the same handle.
    settings.set('NUNCIO_ORCHESTRATION_TOOLS', 'off');
    const res = await tool.execute({});
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res as { content: Array<{ text: string }> }).content[0].text).toContain('disabled');
  });
});
