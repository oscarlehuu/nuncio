import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentToolsModule } from '../../../src/agents/tools/agent-tools.module';
import { AgentToolRegistry } from '../../../src/agents/tools/agent-tool-registry';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SettingsRepository } from '../../../src/settings/persistence/settings.repository';
import { TasksModule } from '../../../src/tasks/tasks.module';

// Level-3 wiring: the orchestration tools reach AgentToolRegistry.forSession —
// the same value that flows into AgentRunContext.tools — gated by the setting.
describe('orchestration tools wiring', () => {
  let module: TestingModule;
  let registry: AgentToolRegistry;
  let settings: SettingsRepository;
  let sessions: SessionsRepository;
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
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  function toolNames(sessionId: string, projectPath: string | null): string[] {
    return registry.forSession({ sessionId, projectPath }).tools.map((t) => t.name);
  }

  it('off (default) → no nuncio_* orchestration tools present', () => {
    settings.delete('NUNCIO_ORCHESTRATION_TOOLS');
    const s = sessions.create({ prompt: 'p', projectPath: '/repo' });
    expect(toolNames(s.id, '/repo').filter((n) => n.startsWith('nuncio_'))).toEqual([]);
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
