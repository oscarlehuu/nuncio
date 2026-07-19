import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { MCP_SETTINGS_KEY, McpServersRepository } from '../../../src/mcp/persistence/mcp-servers.repository';
import { McpOAuthRepository } from '../../../src/mcp/persistence/mcp-oauth.repository';
import { McpOAuthService } from '../../../src/mcp/oauth/mcp-oauth.service';
import { NuncioMcpOAuthProvider } from '../../../src/mcp/oauth/nuncio-mcp-oauth.provider';

describe('McpOAuthService', () => {
  let module: TestingModule;
  let service: McpOAuthService;
  let servers: McpServersRepository;
  let oauth: McpOAuthRepository;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-mcp-oauth-svc-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        McpServersRepository,
        McpOAuthRepository,
        McpOAuthService,
        { provide: MCP_SETTINGS_KEY, useValue: randomBytes(32) },
      ],
    }).compile();
    service = module.get(McpOAuthService);
    servers = module.get(McpServersRepository);
    oauth = module.get(McpOAuthRepository);
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('reports oauth status from stored tokens', () => {
    const created = servers.create({
      name: 'oauth-srv',
      transport: { type: 'http', url: 'https://oauth.example/mcp' },
      auth: 'oauth',
    });
    expect(service.oauthStatus(created.id, 'oauth')).toBe('required');
    oauth.upsert(created.id, {
      tokens: { access_token: 'tok', token_type: 'bearer' },
      redirectUri: 'https://app/cb',
    });
    expect(service.oauthStatus(created.id, 'oauth')).toBe('connected');
    expect(service.oauthStatus(created.id, 'none')).toBe('none');
  });

  it('captures authorization URL via NuncioMcpOAuthProvider redirect hook', () => {
    const provider = new NuncioMcpOAuthProvider('srv', 'https://app/cb', oauth);
    provider.redirectToAuthorization(new URL('https://auth.example/authorize?x=1'));
    expect(provider.pendingAuthorizationUrl).toBe('https://auth.example/authorize?x=1');
  });
});
