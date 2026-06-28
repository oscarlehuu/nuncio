import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../../../src/db/database.module';
import { CursorLocalSessionsService } from '../../../src/cursor-local/cursor-local-sessions.service';
import { toProjectSlug } from '../../../src/cursor-local/cursor-project-slug';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';

describe('CursorLocalSessionsService', () => {
  let module: TestingModule;
  let service: CursorLocalSessionsService;
  let fakeHome: string;
  let workspace: string;

  beforeAll(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'nuncio-cursor-home-'));
    workspace = join(fakeHome, 'projects', 'demo-repo');
    const slug = toProjectSlug(workspace);
    const chatRoot = join(fakeHome, '.cursor/projects', slug, 'agent-transcripts');

    const olderId = '11111111-1111-1111-1111-111111111111';
    const newerId = '22222222-2222-2222-2222-222222222222';
    const olderBase = new Date('2026-01-01T00:00:00Z');
    const newerBase = new Date('2026-01-02T00:00:00Z');
    for (const [id, title, mtime] of [
      [olderId, 'Older task', olderBase],
      [newerId, 'Newer task', newerBase],
    ] as const) {
      const dir = join(chatRoot, id);
      mkdirSync(dir, { recursive: true });
      const jsonl = join(dir, `${id}.jsonl`);
      writeFileSync(
        jsonl,
        [
          JSON.stringify({
            role: 'user',
            message: { content: [{ type: 'text', text: `<user_query>${title}</user_query>` }] },
          }),
          JSON.stringify({
            role: 'assistant',
            message: { content: [{ type: 'text', text: `Reply to ${title}` }] },
          }),
        ].join('\n') + '\n',
      );
      utimesSync(jsonl, mtime, mtime);
    }

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
      providers: [CursorLocalSessionsService],
    }).compile();
    service = module.get(CursorLocalSessionsService);
    service.homeDir = () => fakeHome;
  });

  afterAll(async () => {
    await module.close();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('lists sessions sorted by updatedAt desc', () => {
    const items = service.listForWorkspace(workspace);
    expect(items.length).toBe(2);
    expect(items[0]!.chatId).toBe('22222222-2222-2222-2222-222222222222');
    expect(items[0]!.title).toBe('Newer task');
    expect(items[1]!.preview).toContain('Reply to');
  });

  it('find returns a single chat', () => {
    const item = service.find('11111111-1111-1111-1111-111111111111', workspace);
    expect(item?.title).toBe('Older task');
  });

  it('readTranscript returns parsed turns', () => {
    const turns = service.readTranscript('11111111-1111-1111-1111-111111111111', workspace);
    expect(turns.length).toBe(2);
    expect(turns[0]?.role).toBe('user');
    expect(turns[1]?.text).toContain('Reply');
  });
});
