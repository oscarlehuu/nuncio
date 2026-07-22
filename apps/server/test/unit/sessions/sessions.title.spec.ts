import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsService } from '../../../src/sessions/sessions.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('session titles derive from the user prompt, not the composed preamble', () => {
  let module: TestingModule;
  let service: SessionsService;
  let repo: SessionsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-title-spec-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();

    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule, GitModule, CursorLocalModule],
        providers: [SessionsService],
      }),
    ).compile();

    service = module.get(SessionsService);
    repo = module.get(SessionsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('repository uses rawPrompt for the title when provided', () => {
    const created = repo.create({
      prompt: '## Handoff brief\n\ncomposed preamble body',
      rawPrompt: 'Fix the auth bug in login flow',
      provider: 'cursor',
    });
    expect(created.title).toBe('Fix the auth bug in login flow');
  });

  it('repository falls back to the prompt first line without rawPrompt', () => {
    const created = repo.create({ prompt: 'Plain prompt\nmore', provider: 'cursor' });
    expect(created.title).toBe('Plain prompt');
  });

  it('a preamble-composed session keeps the original request as its title', async () => {
    const session = await service.create({
      prompt: 'Add a greeting function to app.js',
      provider: 'cursor',
      contextBrief: { goal: 'Continue the delegated work.' },
    });

    // The stored prompt IS composed (brief first)…
    expect(session.prompt).toContain('## Handoff brief');
    // …but the title must come from the user's actual request.
    expect(session.title).toBe('Add a greeting function to app.js');
  });
});
