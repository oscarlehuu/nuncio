import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { MCP_SETTINGS_KEY, McpServersRepository } from '../../../src/mcp/persistence/mcp-servers.repository';
import { McpService } from '../../../src/mcp/mcp.service';
import type { McpStdioTransport } from '../../../src/mcp/domain/mcp.types';

describe('McpService', () => {
  let module: TestingModule;
  let service: McpService;
  let repo: McpServersRepository;
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

    it('rejects a remote transport with an invalid url', () => {
      expect(() =>
        service.create({
          name: 'broken-url',
          transport: { type: 'http', url: 'not a url' },
        }),
      ).toThrow(/url/i);
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

    it('returns null for unknown ids', () => {
      expect(service.update('missing', { enabled: false })).toBeNull();
    });
  });
});
