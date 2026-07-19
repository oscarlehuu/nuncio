import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { MCP_SETTINGS_KEY } from '../../../src/mcp/persistence/mcp-servers.repository';
import { McpOAuthRepository } from '../../../src/mcp/persistence/mcp-oauth.repository';
import { isEncrypted } from '../../../src/settings/settings.crypto';

describe('McpOAuthRepository', () => {
  let module: TestingModule;
  let repo: McpOAuthRepository;
  let database: DatabaseService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-mcp-oauth-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        McpOAuthRepository,
        { provide: MCP_SETTINGS_KEY, useValue: randomBytes(32) },
      ],
    }).compile();
    repo = module.get(McpOAuthRepository);
    database = module.get(DatabaseService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('encrypts tokens and client info at rest', () => {
    repo.upsert('figma', {
      tokens: { access_token: 'secret-token', token_type: 'bearer' },
      clientInfo: { client_id: 'nuncio-client' },
      codeVerifier: 'verifier-123',
      state: 'state-abc',
      redirectUri: 'https://app.example/api/mcp/oauth/callback',
    });
    const raw = database.db
      .prepare<{ tokens_json: string }, [string]>(
        'SELECT tokens_json FROM mcp_oauth WHERE server_id = ?',
      )
      .get('figma');
    expect(raw?.tokens_json).toBeDefined();
    expect(isEncrypted(raw!.tokens_json)).toBe(true);

    const row = repo.get('figma');
    expect(row?.tokens?.access_token).toBe('secret-token');
    expect(row?.clientInfo?.client_id).toBe('nuncio-client');
    expect(row?.codeVerifier).toBe('verifier-123');
    expect(row?.state).toBe('state-abc');
  });

  it('finds a row by OAuth state', () => {
    repo.upsert('memory', { state: 'find-me', redirectUri: 'https://x/cb' });
    expect(repo.findByState('find-me')?.serverId).toBe('memory');
    expect(repo.findByState('missing')).toBeNull();
  });
});
