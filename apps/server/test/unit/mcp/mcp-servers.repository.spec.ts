import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { MCP_SETTINGS_KEY, McpServersRepository } from '../../../src/mcp/persistence/mcp-servers.repository';
import { transportIdentity } from '../../../src/mcp/domain/mcp-transport';
import type { McpStdioTransport } from '../../../src/mcp/domain/mcp.types';

describe('McpServersRepository', () => {
  let module: TestingModule;
  let repo: McpServersRepository;
  let database: DatabaseService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-mcp-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        McpServersRepository,
        { provide: MCP_SETTINGS_KEY, useValue: randomBytes(32) },
      ],
    }).compile();

    repo = module.get(McpServersRepository);
    database = module.get(DatabaseService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('creates a server with defaults (enabled, lazy, global, no auth)', () => {
    const created = repo.create({
      name: 'bridgememory',
      transport: { type: 'stdio', command: 'node', args: ['/x/server.cjs'] },
      sources: ['import:cursor'],
    });
    expect(created.id).toBe('bridgememory');
    expect(created.enabled).toBe(true);
    expect(created.advertise).toBe('lazy');
    expect(created.projectPath).toBeNull();
    expect(created.engines).toBeNull();
    expect(created.auth).toBe('none');
    expect(created.sources).toEqual(['import:cursor']);
    expect(created.createdAt).toBeGreaterThan(0);
    expect(repo.get('bridgememory')?.name).toBe('bridgememory');
  });

  it('generates unique kebab ids on name collision', () => {
    const first = repo.create({
      name: 'My Server!',
      transport: { type: 'http', url: 'https://one.example/mcp' },
    });
    const second = repo.create({
      name: 'My Server!',
      transport: { type: 'http', url: 'https://two.example/mcp' },
    });
    expect(first.id).toBe('my-server');
    expect(second.id).toBe('my-server-2');
  });

  it('encrypts secret env values at rest and decrypts on read', () => {
    const created = repo.create({
      name: 'secretive',
      transport: {
        type: 'stdio',
        command: 'run',
        args: [],
        env: { API_TOKEN: 'supersecret', PLAIN: 'visible' },
      },
      secretKeys: ['API_TOKEN'],
    });
    const env = (created.transport as McpStdioTransport).env;
    expect(env).toEqual({ API_TOKEN: 'supersecret', PLAIN: 'visible' });

    const raw = database.db
      .prepare<{ transport_json: string }, [string]>(
        'SELECT transport_json FROM mcp_servers WHERE id = ?',
      )
      .get(created.id);
    expect(raw?.transport_json).not.toContain('supersecret');
    expect(raw?.transport_json).toContain('v1:');
    expect(raw?.transport_json).toContain('visible');

    expect((repo.get(created.id)?.transport as McpStdioTransport).env).toEqual({
      API_TOKEN: 'supersecret',
      PLAIN: 'visible',
    });
  });

  it('encrypts secret header values on remote transports', () => {
    const created = repo.create({
      name: 'remote-secret',
      transport: {
        type: 'http',
        url: 'https://remote.example/mcp',
        headers: { Authorization: 'Bearer abc123', 'X-Plain': 'ok' },
      },
      secretKeys: ['Authorization'],
    });
    const raw = database.db
      .prepare<{ transport_json: string }, [string]>(
        'SELECT transport_json FROM mcp_servers WHERE id = ?',
      )
      .get(created.id);
    expect(raw?.transport_json).not.toContain('Bearer abc123');
    const roundTripped = repo.get(created.id);
    expect(roundTripped?.transport).toEqual({
      type: 'http',
      url: 'https://remote.example/mcp',
      headers: { Authorization: 'Bearer abc123', 'X-Plain': 'ok' },
    });
  });

  it('lists servers ordered by name', () => {
    const names = repo.list().map((server) => server.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('updates fields and bumps updated_at', async () => {
    const created = repo.create({
      name: 'togglable',
      transport: { type: 'http', url: 'https://toggle.example/mcp' },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = repo.update(created.id, {
      enabled: false,
      advertise: 'full',
      engines: ['claude', 'pi'],
      description: 'now described',
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.advertise).toBe('full');
    expect(updated?.engines).toEqual(['claude', 'pi']);
    expect(updated?.description).toBe('now described');
    expect(updated?.updatedAt).toBeGreaterThan(created.updatedAt);
  });

  it('update replaces transport and the identity follows', () => {
    const created = repo.create({
      name: 'moving',
      transport: { type: 'http', url: 'https://old.example/mcp' },
    });
    const newTransport = { type: 'http', url: 'https://new.example/mcp' } as const;
    repo.update(created.id, { transport: newTransport });
    expect(repo.findByIdentity(transportIdentity(newTransport), null)?.id).toBe(created.id);
    expect(repo.findByIdentity(transportIdentity(created.transport), null)).toBeNull();
  });

  it('update returns null for unknown id', () => {
    expect(repo.update('nope', { enabled: false })).toBeNull();
  });

  it('findByIdentity distinguishes global from project scope', () => {
    const transport: McpStdioTransport = { type: 'stdio', command: 'scoped', args: [] };
    const globalRow = repo.create({ name: 'scoped-global', transport });
    const projectRow = repo.create({
      name: 'scoped-project',
      transport,
      projectPath: '/Users/me/proj',
    });
    expect(repo.findByIdentity(transportIdentity(transport), null)?.id).toBe(globalRow.id);
    expect(repo.findByIdentity(transportIdentity(transport), '/Users/me/proj')?.id).toBe(
      projectRow.id,
    );
    expect(repo.findByIdentity(transportIdentity(transport), '/Users/me/other')).toBeNull();
  });

  it('addSource merges provenance without duplicates', () => {
    const created = repo.create({
      name: 'multi-source',
      transport: { type: 'stdio', command: 'multi', args: [] },
      sources: ['import:cursor'],
    });
    repo.addSource(created.id, 'import:claude');
    repo.addSource(created.id, 'import:claude');
    expect(repo.get(created.id)?.sources).toEqual(['import:cursor', 'import:claude']);
  });

  it('round-trips a plaintext secret that itself looks like ciphertext (v1: prefix)', () => {
    const created = repo.create({
      name: 'v1-lookalike',
      transport: {
        type: 'stdio',
        command: 'x',
        args: [],
        env: { API_TOKEN: 'v1:not:really-ciphertext' },
      },
      secretKeys: ['API_TOKEN'],
    });
    expect((repo.get(created.id)?.transport as McpStdioTransport).env?.API_TOKEN).toBe(
      'v1:not:really-ciphertext',
    );
    const raw = database.db
      .prepare<{ transport_json: string }, [string]>(
        'SELECT transport_json FROM mcp_servers WHERE id = ?',
      )
      .get(created.id);
    expect(raw?.transport_json).not.toContain('not:really-ciphertext');
  });

  it('degrades an undecryptable stored secret to an empty value instead of throwing', () => {
    const created = repo.create({
      name: 'poison',
      transport: { type: 'stdio', command: 'p', args: [], env: { API_TOKEN: 'fine' } },
      secretKeys: ['API_TOKEN'],
    });
    database.db
      .prepare('UPDATE mcp_servers SET transport_json = ? WHERE id = ?')
      .run(
        JSON.stringify({
          type: 'stdio',
          command: 'p',
          args: [],
          env: { API_TOKEN: 'v1:00:11' },
        }),
        created.id,
      );
    expect(() => repo.list()).not.toThrow();
    expect((repo.get(created.id)?.transport as McpStdioTransport).env?.API_TOKEN).toBe('');
  });

  it('deletes a server', () => {
    const created = repo.create({
      name: 'doomed',
      transport: { type: 'stdio', command: 'doom', args: [] },
    });
    expect(repo.delete(created.id)).toBe(true);
    expect(repo.get(created.id)).toBeNull();
    expect(repo.delete(created.id)).toBe(false);
  });
});
