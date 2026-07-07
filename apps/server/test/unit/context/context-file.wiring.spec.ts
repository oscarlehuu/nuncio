import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { ContextModule } from '../../../src/context/context.module';
import { CONTEXT_FILE_POINTER } from '../../../src/context/context-file.materializer';
import { ContextFactsService } from '../../../src/context/context-facts.service';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { PromptsModule } from '../../../src/prompts/prompts.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('context-file materialization wiring (B4)', () => {
  let module: TestingModule;
  let sessions: SessionsService;
  let facts: ContextFactsService;
  let settings: SettingsService;
  let dataDir: string;
  let repo: string;

  async function git(cwd: string, ...args: string[]): Promise<void> {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-ctxfile-wire-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule, GitModule, CursorLocalModule, ContextModule, PromptsModule, SettingsModule],
        providers: [SessionsService],
      }),
    ).compile();
    sessions = module.get(SessionsService);
    facts = module.get(ContextFactsService);
    settings = module.get(SettingsService);
  });

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'nuncio-ctxfile-repo-'));
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.email', 't@e.com');
    await git(repo, 'config', 'user.name', 'T');
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('worktree-local + a profile with contextFileName writes the file into the worktree', async () => {
    // DB profile override supplies the engine's context file name for cursor.
    settings.set('NUNCIO_PROMPT_PROFILE_CURSOR', '---\nprovider: cursor\ncontextFileName: AGENTS.local.md\n---\n');
    settings.set('NUNCIO_CONTEXT_FILE_POLICY', 'worktree-local');
    facts.upsert({ projectPath: repo, key: 'build-command', value: 'make it', provenance: 'founder' });
    try {
      const session = await sessions.create({ prompt: 'do it', provider: 'cursor', projectPath: repo, useWorktree: true });
      const wt = sessions.get(session.id)?.worktreePath;
      expect(wt).toBeTruthy();
      const file = join(wt!, 'AGENTS.local.md');
      expect(existsSync(file)).toBe(true);
      const content = readFileSync(file, 'utf8');
      expect(content).toContain('**build-command**: make it');
      expect(content).toContain(CONTEXT_FILE_POINTER);
      // Added to the worktree's git-info exclude (a linked worktree's `.git` is a
      // file pointing at the real gitdir), never the repo .gitignore.
      const dotGit = join(wt!, '.git');
      const gitDir = statSync(dotGit).isDirectory()
        ? dotGit
        : readFileSync(dotGit, 'utf8').trim().replace(/^gitdir:\s*/, '');
      expect(readFileSync(join(gitDir, 'info', 'exclude'), 'utf8')).toContain('AGENTS.local.md');
      expect(existsSync(join(repo, '.gitignore'))).toBe(false); // never the repo gitignore
    } finally {
      settings.set('NUNCIO_CONTEXT_FILE_POLICY', 'none');
    }
  });

  it('none policy writes no context file', async () => {
    settings.set('NUNCIO_PROMPT_PROFILE_CURSOR', '---\nprovider: cursor\ncontextFileName: AGENTS.local.md\n---\n');
    settings.set('NUNCIO_CONTEXT_FILE_POLICY', 'none');
    const session = await sessions.create({ prompt: 'plain', provider: 'cursor', projectPath: repo, useWorktree: true });
    const wt = sessions.get(session.id)?.worktreePath;
    expect(existsSync(join(wt!, 'AGENTS.local.md'))).toBe(false);
  });
});
