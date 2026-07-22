import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { MCP_SETTINGS_KEY, McpServersRepository } from '../../../src/mcp/persistence/mcp-servers.repository';
import { McpService } from '../../../src/mcp/mcp.service';
import { transportIdentity } from '../../../src/mcp/domain/mcp-transport';
import type { McpStdioTransport } from '../../../src/mcp/domain/mcp.types';

describe('McpService', () => {
  let module: TestingModule;
  let service: McpService;
  let repo: McpServersRepository;
  let database: DatabaseService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-mcp-service-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        McpServersRepository,
        McpService,
        { provide: MCP_SETTINGS_KEY, useValue: randomBytes(32) },
      ],
    }).compile();

    service = module.get(McpService);
    repo = module.get(McpServersRepository);
    database = module.get(DatabaseService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  beforeEach(() => {
    for (const server of repo.list()) repo.delete(server.id);
  });

  describe('resolveForSession', () => {
    it('returns enabled global servers for any provider', () => {
      repo.create({ name: 'global-a', transport: { type: 'stdio', command: 'a', args: [] } });
      repo.create({
        name: 'disabled-b',
        transport: { type: 'stdio', command: 'b', args: [] },
        enabled: false,
      });
      const resolved = service.resolveForSession({ provider: 'pi', projectPath: null });
      expect(resolved.map((s) => s.name)).toEqual(['global-a']);
    });

    it('includes project-scoped servers only for the matching project', () => {
      repo.create({ name: 'everywhere', transport: { type: 'stdio', command: 'g', args: [] } });
      repo.create({
        name: 'proj-only',
        transport: { type: 'stdio', command: 'p', args: [] },
        projectPath: '/Users/me/proj',
      });
      const inProject = service.resolveForSession({
        provider: 'pi',
        projectPath: '/Users/me/proj',
      });
      expect(inProject.map((s) => s.name).sort()).toEqual(['everywhere', 'proj-only']);

      const elsewhere = service.resolveForSession({
        provider: 'pi',
        projectPath: '/Users/me/other',
      });
      expect(elsewhere.map((s) => s.name)).toEqual(['everywhere']);

      const noProject = service.resolveForSession({ provider: 'pi', projectPath: null });
      expect(noProject.map((s) => s.name)).toEqual(['everywhere']);
    });

    it('normalizes trailing slashes when matching project paths', () => {
      repo.create({
        name: 'slashy',
        transport: { type: 'stdio', command: 's', args: [] },
        projectPath: '/Users/me/proj/',
      });
      const resolved = service.resolveForSession({
        provider: 'claude',
        projectPath: '/Users/me/proj',
      });
      expect(resolved.map((s) => s.name)).toEqual(['slashy']);
    });

    it('filters by engine allowlist', () => {
      repo.create({
        name: 'claude-only',
        transport: { type: 'stdio', command: 'c', args: [] },
        engines: ['claude'],
      });
      repo.create({ name: 'all-engines', transport: { type: 'stdio', command: 'e', args: [] } });
      expect(
        service.resolveForSession({ provider: 'claude', projectPath: null }).map((s) => s.name),
      ).toEqual(['all-engines', 'claude-only']);
      expect(
        service.resolveForSession({ provider: 'codex', projectPath: null }).map((s) => s.name),
      ).toEqual(['all-engines']);
    });

    it('prefers explicit session mcpServerIds over scoped defaults', () => {
      const alpha = repo.create({ name: 'alpha', transport: { type: 'stdio', command: 'a', args: [] } });
      repo.create({ name: 'beta', transport: { type: 'stdio', command: 'b', args: [] } });
      const resolved = service.resolveForSession({
        provider: 'pi',
        projectPath: null,
        mcpServerIds: [alpha.id],
      });
      expect(resolved.map((s) => s.id)).toEqual([alpha.id]);
    });

    it('empty session mcpServerIds yields no servers', () => {
      repo.create({ name: 'solo', transport: { type: 'stdio', command: 's', args: [] } });
      const resolved = service.resolveForSession({
        provider: 'pi',
        projectPath: null,
        mcpServerIds: [],
      });
      expect(resolved).toEqual([]);
    });
  });

  describe('DTO mapping', () => {
    it('masks secret env values and never returns plaintext', () => {
      const created = service.create({
        name: 'masked',
        transport: {
          type: 'stdio',
          command: 'run',
          args: [],
          env: { API_TOKEN: 'supersecret99', PLAIN: 'ok' },
        },
        secretKeys: ['API_TOKEN'],
      });
      const env = (created.transport as McpStdioTransport).env;
      expect(env?.API_TOKEN).not.toContain('supersecret');
      expect(env?.API_TOKEN).toContain('••••');
      expect(env?.API_TOKEN).toContain('t99');
      expect(env?.PLAIN).toBe('ok');
      expect(created.scope).toBe('global');
    });

    it('auto-detects and masks direct service create secrets before returning', () => {
      const created = service.create({
        name: 'service-auto-create',
        transport: {
          type: 'stdio',
          command: 'service-mcp',
          args: ['--api-key=service-inline-secret'],
          env: { API_TOKEN: 'service-env-secret', PLAIN: 'visible' },
        },
      });

      const serialized = JSON.stringify(created);
      expect(serialized).not.toContain('service-inline-secret');
      expect(serialized).not.toContain('service-env-secret');
      expect(serialized).toContain('--api-key=');
      expect(created.secretKeys).toEqual(['API_TOKEN']);
      expect(created.secretArgIndexes).toEqual([0]);
      const raw = database.db
        .prepare<{ transport_json: string }, [string]>(
          'SELECT transport_json FROM mcp_servers WHERE id = ?',
        )
        .get(created.id);
      expect(raw?.transport_json).not.toContain('service-inline-secret');
      expect(raw?.transport_json).not.toContain('service-env-secret');
      expect(repo.getRuntime(created.id)?.transport).toEqual({
        type: 'stdio',
        command: 'service-mcp',
        args: ['--api-key=service-inline-secret'],
        env: { API_TOKEN: 'service-env-secret', PLAIN: 'visible' },
      });
    });

    it('masks imported CLI args, URL query values, and arbitrary header values in list DTOs', () => {
      service.create({
        name: 'masked-cli',
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['account-mcp', '--token', 'cli-secret', '--api-key=inline-secret'],
        },
        sources: ['import:cursor'],
        secretKeys: [],
        secretArgIndexes: [2, 3],
        secretUrlQueryKeys: [],
      } as never);
      service.create({
        name: 'masked-remote',
        transport: {
          type: 'http',
          url: 'https://remote.example/mcp?tenant=query-secret',
          headers: { 'X-Account': 'header-secret' },
        },
        sources: ['import:claude'],
        secretKeys: ['X-Account'],
        secretArgIndexes: [],
        secretUrlQueryKeys: ['tenant'],
      } as never);

      const serialized = JSON.stringify(service.list());
      expect(serialized).not.toContain('cli-secret');
      expect(serialized).not.toContain('inline-secret');
      expect(serialized).not.toContain('query-secret');
      expect(serialized).not.toContain('header-secret');
      expect(serialized).toContain('--api-key=');
      expect(serialized).toContain('remote.example');
      expect(serialized).toContain('tenant');
    });

    it('marks project scope on DTOs', () => {
      const created = service.create({
        name: 'proj-dto',
        transport: { type: 'http', url: 'https://x.example/mcp' },
        projectPath: '/Users/me/proj',
      });
      expect(created.scope).toBe('project');
      expect(created.projectPath).toBe('/Users/me/proj');
    });
  });

  describe('create validation', () => {
    it('rejects a stdio transport without a command', () => {
      expect(() =>
        service.create({
          name: 'broken',
          transport: { type: 'stdio', command: '', args: [] },
        }),
      ).toThrow(/command/i);
    });

    it('rejects a remote transport with an invalid url without echoing query secrets', () => {
      let thrown: unknown;
      try {
        service.create({
          name: 'broken-url',
          transport: { type: 'http', url: 'not a url?token=invalid-url-secret' },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/url/i);
      expect((thrown as Error).message).not.toContain('invalid-url-secret');
    });

    it('rejects username-only, password-bearing, and encoded URL userinfo without persistence', () => {
      const unsafeUrls = [
        'https://alice@remote.example/mcp',
        'https://alice:plain-password@remote.example/mcp',
        'https://%61lice:p%40ssword@remote.example/mcp',
      ];
      for (const [index, url] of unsafeUrls.entries()) {
        let thrown: unknown;
        try {
          service.create({ name: `unsafe-${index}`, transport: { type: 'http', url } });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toMatch(/username|password|credentials/i);
        expect((thrown as Error).message).not.toContain('plain-password');
        expect((thrown as Error).message).not.toContain('p%40ssword');
      }
      expect(repo.list()).toEqual([]);
    });

    it('rejects URL userinfo on update and retains the prior transport', () => {
      const created = service.create({
        name: 'safe-before-update',
        transport: { type: 'http', url: 'https://remote.example/original' },
      });
      expect(() =>
        service.update(created.id, {
          transport: { type: 'sse', url: 'https://alice:update-password@remote.example/mcp' },
        }),
      ).toThrow(/username|password|credentials/i);
      expect(repo.get(created.id)?.transport).toEqual({
        type: 'http',
        url: 'https://remote.example/original',
      });
    });

    it('rejects unknown engine ids', () => {
      expect(() =>
        service.create({
          name: 'bad-engine',
          transport: { type: 'stdio', command: 'x', args: [] },
          engines: ['claude', 'grok' as never],
        }),
      ).toThrow(/engine/i);
    });
  });

  describe('secret declassification guard', () => {
    it('never returns or stores a raw secret when secretKeys is shrunk via the API', () => {
      const created = service.create({
        name: 'declassify',
        transport: {
          type: 'http',
          url: 'https://declassify.example/mcp',
          headers: { Authorization: 'Bearer topsecret9' },
        },
        secretKeys: ['Authorization'],
      });
      const updated = service.update(created.id, { secretKeys: [] });
      const headers = (updated?.transport as { headers?: Record<string, string> }).headers;
      expect(headers?.Authorization).not.toContain('topsecret9');
      const stored = repo.get(created.id);
      expect(stored?.secretKeys).toEqual(['Authorization']);
      expect((stored?.transport as { headers?: Record<string, string> }).headers).toEqual({
        Authorization: 'Bearer topsecret9',
      });
    });
  });

  describe('identity conflicts', () => {
    it('rejects a create whose transport identity already exists in the same scope', () => {
      service.create({ name: 'dupe-a', transport: { type: 'stdio', command: 'dupe', args: [] } });
      expect(() =>
        service.create({ name: 'dupe-b', transport: { type: 'stdio', command: 'dupe', args: [] } }),
      ).toThrow(/already registered/i);
    });

    it('allows the same transport in a different project scope', () => {
      service.create({ name: 'scoped-a', transport: { type: 'stdio', command: 'scpd', args: [] } });
      expect(() =>
        service.create({
          name: 'scoped-b',
          transport: { type: 'stdio', command: 'scpd', args: [] },
          projectPath: '/Users/me/proj',
        }),
      ).not.toThrow();
    });

    it('rejects an update that moves a transport onto another row identity', () => {
      service.create({ name: 'move-a', transport: { type: 'http', url: 'https://move-a.example' } });
      const b = service.create({
        name: 'move-b',
        transport: { type: 'http', url: 'https://move-b.example' },
      });
      expect(() =>
        service.update(b.id, { transport: { type: 'http', url: 'https://move-a.example' } }),
      ).toThrow(/already registered/i);
      // moving onto its own identity stays allowed
      expect(() =>
        service.update(b.id, { transport: { type: 'http', url: 'https://move-b.example' } }),
      ).not.toThrow();
    });
  });

  describe('transport normalization', () => {
    it('defaults a missing stdio args array instead of crashing', () => {
      const dto = service.create({
        name: 'no-args',
        transport: { type: 'stdio', command: 'x' } as never,
      });
      expect((dto.transport as McpStdioTransport).args).toEqual([]);
    });
  });

  describe('update', () => {
    it('preserves stored secrets when the caller sends back the masked value', () => {
      const created = service.create({
        name: 'keep-secret',
        transport: {
          type: 'http',
          url: 'https://keep.example/mcp',
          headers: { Authorization: 'Bearer topsecret1' },
        },
        secretKeys: ['Authorization'],
      });
      const masked = created.transport as { headers?: Record<string, string> };
      const updated = service.update(created.id, {
        transport: {
          type: 'http',
          url: 'https://keep.example/mcp',
          headers: { Authorization: masked.headers!.Authorization },
        },
      });
      expect(updated).not.toBeNull();
      const stored = repo.get(created.id);
      expect((stored?.transport as { headers?: Record<string, string> }).headers).toEqual({
        Authorization: 'Bearer topsecret1',
      });
    });

    it('restores masked env and mixed CLI argument secrets before identity and persistence', () => {
      const rawTransport = {
        type: 'stdio' as const,
        command: 'npx',
        args: ['zero-index-secret', '--token', 'separate-secret', '--api-key=inline-secret'],
        env: { API_TOKEN: 'env-secret', PLAIN: 'visible' },
      };
      const created = service.create({
        name: 'mixed-stdio-secrets',
        transport: rawTransport,
        secretKeys: ['API_TOKEN'],
        secretArgIndexes: [0, 2, 3, -1],
      });
      expect(created.secretArgIndexes).toEqual([0, 2, 3]);

      const updated = service.update(created.id, {
        name: 'mixed-stdio-secrets-updated',
        transport: created.transport,
      });

      expect(updated?.name).toBe('mixed-stdio-secrets-updated');
      expect(repo.get(created.id)?.transport).toEqual(rawTransport);
      expect(repo.findByIdentity(transportIdentity(rawTransport), null)?.id).toBe(created.id);
    });

    it('restores masked headers and duplicate Unicode URL query secrets before persistence', () => {
      const rawTransport = {
        type: 'http' as const,
        url: 'https://remote.example/mcp?tenant=first-secret&tenant=s%E1%BA%AFc-second&mode=read',
        headers: { Authorization: 'Bearer header-secret', Accept: 'application/json' },
      };
      const created = service.create({
        name: 'mixed-remote-secrets',
        transport: rawTransport,
        secretKeys: ['Authorization'],
        secretUrlQueryKeys: ['tenant'],
      });

      service.update(created.id, { transport: created.transport });

      const stored = repo.get(created.id);
      expect(stored?.transport).toEqual(rawTransport);
      const storedUrl = new URL((stored?.transport as { url: string }).url);
      expect(storedUrl.searchParams.getAll('tenant')).toEqual(['first-secret', 'sắc-second']);
      expect((stored?.transport as { headers?: Record<string, string> }).headers).toEqual({
        Authorization: 'Bearer header-secret',
        Accept: 'application/json',
      });
      expect(repo.findByIdentity(transportIdentity(rawTransport), null)?.id).toBe(created.id);
    });

    it('auto-detects and masks direct service update secrets before returning', () => {
      const created = service.create({
        name: 'service-auto-update',
        transport: { type: 'http', url: 'https://service-update.example/mcp' },
      });

      const updated = service.update(created.id, {
        transport: {
          type: 'http',
          url: 'https://service-update.example/mcp?tenant=service-query-secret',
          headers: { Authorization: 'Bearer service-header-secret' },
        },
      });

      const serialized = JSON.stringify(updated);
      expect(serialized).not.toContain('service-query-secret');
      expect(serialized).not.toContain('service-header-secret');
      expect(updated?.secretKeys).toEqual(['Authorization']);
      expect(updated?.secretUrlQueryKeys).toEqual(['tenant']);
      const raw = database.db
        .prepare<{ transport_json: string }, [string]>(
          'SELECT transport_json FROM mcp_servers WHERE id = ?',
        )
        .get(created.id);
      expect(raw?.transport_json).not.toContain('service-query-secret');
      expect(raw?.transport_json).not.toContain('service-header-secret');
      expect(repo.getRuntime(created.id)?.transport).toEqual({
        type: 'http',
        url: 'https://service-update.example/mcp?tenant=service-query-secret',
        headers: { Authorization: 'Bearer service-header-secret' },
      });
    });

    it('returns null for unknown ids', () => {
      expect(service.update('missing', { enabled: false })).toBeNull();
    });
  });
});
