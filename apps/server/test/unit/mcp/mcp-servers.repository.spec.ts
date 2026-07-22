import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { encryptValue } from '../../../src/settings/settings.crypto';
import { MCP_SETTINGS_KEY, McpServersRepository } from '../../../src/mcp/persistence/mcp-servers.repository';
import { transportIdentity } from '../../../src/mcp/domain/mcp-transport';
import { McpService } from '../../../src/mcp/mcp.service';
import type { McpStdioTransport } from '../../../src/mcp/domain/mcp.types';

describe('McpServersRepository', () => {
  let module: TestingModule;
  let repo: McpServersRepository;
  let database: DatabaseService;
  let settingsKey: Buffer;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-mcp-repo-'));
    settingsKey = randomBytes(32);
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        McpServersRepository,
        { provide: MCP_SETTINGS_KEY, useValue: settingsKey },
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

  it('encrypts imported CLI args and URL query values in every persisted column', () => {
    const stdio = repo.create({
      name: 'imported-cli-secret',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['account-mcp', '--token', 'cli-arg-secret', '--api-key=inline-arg-secret'],
        env: { GITHUB_PAT: 'github-pat-secret' },
      },
      sources: ['import:cursor'],
      secretKeys: ['GITHUB_PAT'],
      secretArgIndexes: [2, 3],
      secretUrlQueryKeys: [],
    } as never);
    const remote = repo.create({
      name: 'imported-remote-secret',
      transport: {
        type: 'http',
        url: 'https://remote.example/mcp?tenant=query-secret&tenant=second-query-secret',
        headers: { 'X-Account': 'header-secret' },
      },
      sources: ['import:claude'],
      secretKeys: ['X-Account'],
      secretArgIndexes: [],
      secretUrlQueryKeys: ['tenant'],
    } as never);

    const persisted = database.db
      .prepare<
        { transport_json: string; secret_keys_json: string; identity: string },
        [string, string]
      >(
        'SELECT transport_json, secret_keys_json, identity FROM mcp_servers WHERE id IN (?, ?) ORDER BY id',
      )
      .all(stdio.id, remote.id);
    const rawColumns = JSON.stringify(persisted);
    for (const secret of [
      'cli-arg-secret',
      'inline-arg-secret',
      'github-pat-secret',
      'query-secret',
      'second-query-secret',
      'header-secret',
    ]) {
      expect(rawColumns).not.toContain(secret);
    }

    expect(repo.get(stdio.id)?.transport).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['account-mcp', '--token', 'cli-arg-secret', '--api-key=inline-arg-secret'],
      env: { GITHUB_PAT: 'github-pat-secret' },
    });
    expect(repo.get(remote.id)?.transport).toEqual({
      type: 'http',
      url: 'https://remote.example/mcp?tenant=query-secret&tenant=second-query-secret',
      headers: { 'X-Account': 'header-secret' },
    });
  });

  it('auto-detects and seals transport secrets on direct create and update', () => {
    const created = repo.create({
      name: 'direct-auto-detect',
      transport: {
        type: 'stdio',
        command: 'direct-mcp',
        args: ['--api-key=direct-inline-secret'],
        env: { API_TOKEN: 'direct-env-secret', PLAIN: 'visible' },
      },
    });

    expect(created.secretKeys).toEqual(['API_TOKEN']);
    expect(created.secretArgIndexes).toEqual([0]);
    expect(created.transport).toEqual({
      type: 'stdio',
      command: 'direct-mcp',
      args: ['--api-key=direct-inline-secret'],
      env: { API_TOKEN: 'direct-env-secret', PLAIN: 'visible' },
    });
    let raw = rawStoredRow(database, created.id);
    expect(raw?.transport_json).not.toContain('direct-inline-secret');
    expect(raw?.transport_json).not.toContain('direct-env-secret');
    expect(raw?.transport_json).toContain('visible');

    const updated = repo.update(created.id, {
      transport: {
        type: 'http',
        url: 'https://direct.example/mcp?tenant=direct-query-secret',
        headers: {
          Authorization: 'Bearer direct-header-secret',
          'X-Trace': 'direct-trace-secret',
        },
      },
    });

    expect(updated?.secretKeys).toEqual(
      expect.arrayContaining(['API_TOKEN', 'Authorization', 'X-Trace']),
    );
    expect(updated?.secretUrlQueryKeys).toEqual(['tenant']);
    expect(updated?.transport).toEqual({
      type: 'http',
      url: 'https://direct.example/mcp?tenant=direct-query-secret',
      headers: {
        Authorization: 'Bearer direct-header-secret',
        'X-Trace': 'direct-trace-secret',
      },
    });
    raw = rawStoredRow(database, created.id);
    expect(raw?.transport_json).not.toContain('direct-query-secret');
    expect(raw?.transport_json).not.toContain('direct-header-secret');
    expect(raw?.transport_json).not.toContain('direct-trace-secret');
  });

  it('migrates legacy imported rows so existing persisted args and identities no longer expose secrets', () => {
    const now = Date.now();
    const transport = {
      type: 'stdio' as const,
      command: 'npx',
      args: ['account-mcp', '--token', 'legacy-cli-secret'],
      env: { GITHUB_PAT: encryptValue('legacy-github-pat-secret', settingsKey) },
    };
    database.db
      .prepare(
        `INSERT INTO mcp_servers (
          id, name, description, transport_json, enabled, advertise, project_path,
          engines_json, auth, sources_json, secret_keys_json, identity, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-import',
        'legacy-import',
        null,
        JSON.stringify(transport),
        1,
        'lazy',
        null,
        null,
        'none',
        JSON.stringify(['import:cursor']),
        JSON.stringify(['GITHUB_PAT']),
        `stdio:${JSON.stringify(['npx', 'account-mcp', '--token', 'legacy-cli-secret'])}`,
        now,
        now,
      );

    const migratedRepo = new McpServersRepository(database, settingsKey);
    const raw = database.db
      .prepare<{ transport_json: string; secret_keys_json: string; identity: string }, [string]>(
        'SELECT transport_json, secret_keys_json, identity FROM mcp_servers WHERE id = ?',
      )
      .get('legacy-import');
    expect(JSON.stringify(raw)).not.toContain('legacy-cli-secret');
    expect(JSON.stringify(raw)).not.toContain('legacy-github-pat-secret');
    expect(raw?.identity).toMatch(/^v2:/);
    expect(migratedRepo.get('legacy-import')?.transport).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['account-mcp', '--token', 'legacy-cli-secret'],
      env: { GITHUB_PAT: 'legacy-github-pat-secret' },
    });
  });

  it('still migrates a legacy imported row that has no marked ciphertext', () => {
    withIsolatedDatabase((isolated) => {
      const key = randomBytes(32);
      const transport: McpStdioTransport = {
        type: 'stdio',
        command: 'plain-mcp',
        args: ['--safe'],
      };
      insertImportedRow(isolated, {
        id: 'plaintext-import',
        transport,
        secretMetadata: JSON.stringify([]),
        identity: 'legacy-plaintext-identity',
      });

      new McpServersRepository(isolated, key);

      const migrated = rawStoredRow(isolated, 'plaintext-import');
      expect(migrated?.identity).toBe(transportIdentity(transport));
      expect(JSON.parse(migrated!.transport_json)).toEqual(transport);
    });
  });

  it('leaves a legacy imported row byte-for-byte unchanged when opened with the wrong key', () => {
    withIsolatedDatabase((isolated) => {
      const correctKey = randomBytes(32);
      const wrongKey = randomBytes(32);
      insertImportedRow(isolated, {
        id: 'wrong-key-import',
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['account-mcp', '--token', 'legacy-cli-secret'],
          env: { API_TOKEN: encryptValue('legacy-env-secret', correctKey) },
        },
        secretMetadata: JSON.stringify(['API_TOKEN']),
        identity: 'legacy-plaintext-identity',
      });
      const before = rawStoredRow(isolated, 'wrong-key-import');

      new McpServersRepository(isolated, wrongKey);

      expect(rawStoredRow(isolated, 'wrong-key-import')).toEqual(before);
    });
  });

  it('does not orphan plaintext-only legacy secrets when a wrong key boots first', () => {
    withIsolatedDatabase((isolated) => {
      const correctKey = randomBytes(32);
      const wrongKey = randomBytes(32);
      const secret = 'khóa-秘密-legacy';
      writeFileSync(join(isolated.dataDir, 'settings.key'), correctKey, { mode: 0o600 });
      insertImportedRow(isolated, {
        id: 'plaintext-only-wrong-key',
        transport: {
          type: 'stdio',
          command: 'legacy-mcp',
          args: [`--api-key=${secret}`],
        },
        secretMetadata: JSON.stringify([]),
        identity: 'legacy-plaintext-only-identity',
      });
      const before = rawStoredRow(isolated, 'plaintext-only-wrong-key');

      const wrongRepo = new McpServersRepository(isolated, wrongKey);
      const wrongService = new McpService(wrongRepo);

      expect(rawStoredRow(isolated, 'plaintext-only-wrong-key')).toEqual(before);
      expect(JSON.stringify(wrongService.get('plaintext-only-wrong-key'))).not.toContain(secret);
      expect(wrongRepo.getRuntime('plaintext-only-wrong-key')).toBeNull();
      expect(existsSync(join(isolated.dataDir, 'mcp-settings-key.verifier'))).toBe(false);

      const recoveredRepo = new McpServersRepository(isolated, correctKey);
      expect(recoveredRepo.getRuntime('plaintext-only-wrong-key')?.transport).toEqual({
        type: 'stdio',
        command: 'legacy-mcp',
        args: [`--api-key=${secret}`],
      });
      const recovered = rawStoredRow(isolated, 'plaintext-only-wrong-key');
      expect(recovered?.transport_json).not.toContain(secret);
      expect(recovered?.transport_json).toContain('v1:');
      expect(recovered?.secret_keys_json).toContain('secretArgIndexes');
      const verifierPath = join(isolated.dataDir, 'mcp-settings-key.verifier');
      expect(readFileSync(verifierPath, 'utf8').startsWith('v1:')).toBe(true);

      new McpServersRepository(isolated, correctKey);
      expect(rawStoredRow(isolated, 'plaintext-only-wrong-key')).toEqual(recovered);
    });
  });

  it('keeps first-install secret writes available without pre-existing key evidence', () => {
    withIsolatedDatabase((isolated) => {
      const key = randomBytes(32);
      const freshRepo = new McpServersRepository(isolated, key);
      const created = freshRepo.create({
        name: 'fresh-secret',
        transport: {
          type: 'stdio',
          command: 'fresh-mcp',
          args: ['--api-key=fresh-install-secret'],
        },
      });

      expect(freshRepo.getRuntime(created.id)?.transport).toEqual({
        type: 'stdio',
        command: 'fresh-mcp',
        args: ['--api-key=fresh-install-secret'],
      });
      expect(rawStoredRow(isolated, created.id)?.transport_json).not.toContain(
        'fresh-install-secret',
      );
      expect(
        readFileSync(join(isolated.dataDir, 'mcp-settings-key.verifier'), 'utf8').startsWith('v1:'),
      ).toBe(true);
    });
  });

  it('does not partially rewrite a row when one of several marked ciphertexts is undecryptable', () => {
    withIsolatedDatabase((isolated) => {
      const key = randomBytes(32);
      insertImportedRow(isolated, {
        id: 'partial-decrypt-import',
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['account-mcp', '--token', 'legacy-cli-secret'],
          env: {
            API_TOKEN: encryptValue('decryptable-secret', key),
            SECOND_TOKEN: 'v1:00:11',
          },
        },
        secretMetadata: JSON.stringify(['API_TOKEN', 'SECOND_TOKEN']),
        identity: 'legacy-partial-identity',
      });
      const before = rawStoredRow(isolated, 'partial-decrypt-import');

      new McpServersRepository(isolated, key);

      expect(rawStoredRow(isolated, 'partial-decrypt-import')).toEqual(before);
    });
  });

  it('migrates prior-schema imported and manual URL userinfo into encrypted Basic authorization', () => {
    withIsolatedDatabase((isolated) => {
      const key = randomBytes(32);
      writeFileSync(join(isolated.dataDir, 'settings.key'), key, { mode: 0o600 });
      insertStoredRow(isolated, {
        id: 'legacy-import-userinfo',
        transport: {
          type: 'http',
          url: 'https://alice:p%40ss@remote.example/mcp?mode=read',
        },
        sources: ['import:cursor'],
      });
      insertStoredRow(isolated, {
        id: 'legacy-manual-userinfo',
        transport: {
          type: 'sse',
          url: 'https://manual%2Dprincipal@manual.example/events',
        },
        sources: ['nuncio'],
      });

      const migrated = new McpServersRepository(isolated, key);

      expect(migrated.get('legacy-import-userinfo')?.transport).toEqual({
        type: 'http',
        url: 'https://remote.example/mcp?mode=read',
        headers: { Authorization: basicAuthorization('alice', 'p@ss') },
      });
      expect(migrated.get('legacy-manual-userinfo')?.transport).toEqual({
        type: 'sse',
        url: 'https://manual.example/events',
        headers: { Authorization: basicAuthorization('manual-principal', '') },
      });

      const raw = [
        rawStoredRow(isolated, 'legacy-import-userinfo'),
        rawStoredRow(isolated, 'legacy-manual-userinfo'),
      ];
      const serialized = JSON.stringify(raw);
      const apiJson = JSON.stringify({
        get: new McpService(migrated).get('legacy-import-userinfo'),
        list: new McpService(migrated).list(),
      });
      for (const secret of [
        'alice',
        'p%40ss',
        'p@ss',
        'manual%2Dprincipal',
        'manual-principal',
        basicAuthorization('alice', 'p@ss'),
        basicAuthorization('manual-principal', ''),
      ]) {
        expect(serialized).not.toContain(secret);
        expect(apiJson).not.toContain(secret);
      }
      expect(apiJson).toContain('••••');
      expect(raw.every((row) => row?.transport_json.includes('v1:'))).toBe(true);
      expect(raw.every((row) => row?.secret_keys_json.includes('Authorization'))).toBe(true);
      expect(raw.every((row) => row?.enabled === 1)).toBe(true);
    });
  });

  it('quarantines prior-schema URL userinfo that conflicts with authorization or OAuth', () => {
    withIsolatedDatabase((isolated) => {
      const key = randomBytes(32);
      insertStoredRow(isolated, {
        id: 'legacy-conflicting-userinfo',
        transport: {
          type: 'http',
          url: 'https://alice:discard-me@remote.example/mcp',
          headers: { authorization: encryptValue('Bearer keep-existing', key) },
        },
        secretMetadata: JSON.stringify(['authorization']),
        sources: ['nuncio'],
      });
      insertStoredRow(isolated, {
        id: 'legacy-oauth-userinfo',
        transport: {
          type: 'http',
          url: 'https://credential-user:discard-oauth@oauth.example/mcp',
        },
        auth: 'oauth',
        sources: ['import:codex'],
      });

      const migrated = new McpServersRepository(isolated, key);
      const service = new McpService(migrated);

      const conflict = migrated.get('legacy-conflicting-userinfo');
      expect(conflict?.enabled).toBe(false);
      expect(conflict?.transport).toEqual({
        type: 'http',
        url: 'https://remote.example/mcp',
        headers: { authorization: 'Bearer keep-existing' },
      });
      const oauth = migrated.get('legacy-oauth-userinfo');
      expect(oauth?.enabled).toBe(false);
      expect(oauth?.transport).toEqual({ type: 'http', url: 'https://oauth.example/mcp' });

      const apiJson = JSON.stringify(service.list());
      const storedJson = JSON.stringify([
        rawStoredRow(isolated, 'legacy-conflicting-userinfo'),
        rawStoredRow(isolated, 'legacy-oauth-userinfo'),
      ]);
      for (const secret of ['discard-me', 'discard-oauth', 'credential-user', 'keep-existing']) {
        expect(apiJson).not.toContain(secret);
        expect(storedJson).not.toContain(secret);
      }
      expect(service.resolveForSession({ provider: 'pi', projectPath: null })).toEqual([]);
    });
  });

  it('quarantines URL userinfo under a wrong key without mutating existing ciphertext', () => {
    withIsolatedDatabase((isolated) => {
      const correctKey = randomBytes(32);
      const wrongKey = randomBytes(32);
      const existingCiphertext = encryptValue('existing-header-secret', correctKey);
      insertStoredRow(isolated, {
        id: 'wrong-key-userinfo',
        transport: {
          type: 'http',
          url: 'https://credential-owner:discard-userinfo@remote.example/mcp',
          headers: { 'X-Token': existingCiphertext },
        },
        secretMetadata: JSON.stringify(['X-Token']),
        sources: ['nuncio'],
      });

      const wrongRepo = new McpServersRepository(isolated, wrongKey);
      const stored = rawStoredRow(isolated, 'wrong-key-userinfo');
      const rawTransport = JSON.parse(stored!.transport_json) as {
        url: string;
        headers: Record<string, string>;
      };
      expect(stored?.enabled).toBe(0);
      expect(rawTransport.url).toBe('https://remote.example/mcp');
      expect(rawTransport.headers['X-Token']).toBe(existingCiphertext);
      expect(JSON.stringify(new McpService(wrongRepo).list())).not.toContain('discard-userinfo');
      expect(wrongRepo.getRuntime('wrong-key-userinfo')).toBeNull();

      const recoveredRepo = new McpServersRepository(isolated, correctKey);
      expect(recoveredRepo.get('wrong-key-userinfo')?.transport).toEqual({
        type: 'http',
        url: 'https://remote.example/mcp',
        headers: { 'X-Token': 'existing-header-secret' },
      });
      expect(recoveredRepo.get('wrong-key-userinfo')?.enabled).toBe(false);
    });
  });

  it('masks a mixed corrupt-ciphertext row under the wrong key and recovers it under the correct key', () => {
    withIsolatedDatabase((isolated) => {
      const correctKey = randomBytes(32);
      const wrongKey = randomBytes(32);
      const rawTransport = {
        type: 'stdio' as const,
        command: 'npx',
        args: [
          '--api-key=plain-inline-secret',
          'https://args.example/mcp?token=plain-query-secret&token=second-query-secret',
        ],
        env: { API_TOKEN: encryptValue('encrypted-env-secret', correctKey) },
      };
      insertStoredRow(isolated, {
        id: 'mixed-wrong-key',
        transport: rawTransport,
        secretMetadata: JSON.stringify(['API_TOKEN']),
        sources: ['import:claude'],
      });
      const before = rawStoredRow(isolated, 'mixed-wrong-key');

      const wrongRepo = new McpServersRepository(isolated, wrongKey);
      const wrongService = new McpService(wrongRepo);
      const apiJson = JSON.stringify({
        get: wrongService.get('mixed-wrong-key'),
        list: wrongService.list(),
      });
      for (const secret of [
        'plain-inline-secret',
        'plain-query-secret',
        'second-query-secret',
        'encrypted-env-secret',
      ]) {
        expect(apiJson).not.toContain(secret);
      }
      expect(apiJson).toContain('--api-key=');
      expect(apiJson).toContain('token=');
      expect(
        wrongService.resolveForSession({ provider: 'pi', projectPath: null }),
      ).toEqual([]);
      expect(rawStoredRow(isolated, 'mixed-wrong-key')).toEqual(before);

      const recoveredRepo = new McpServersRepository(isolated, correctKey);
      const recoveredService = new McpService(recoveredRepo);
      const stored = rawStoredRow(isolated, 'mixed-wrong-key');
      const storedJson = JSON.stringify(stored);
      for (const secret of [
        'plain-inline-secret',
        'plain-query-secret',
        'second-query-secret',
        'encrypted-env-secret',
      ]) {
        expect(storedJson).not.toContain(secret);
      }
      expect(stored?.secret_keys_json).toContain('secretArgIndexes');
      expect(stored?.transport_json.match(/v1:/g)?.length).toBe(3);
      expect(recoveredService.resolveForSession({ provider: 'pi', projectPath: null })).toEqual([
        expect.objectContaining({
          id: 'mixed-wrong-key',
          transport: {
            type: 'stdio',
            command: 'npx',
            args: [
              '--api-key=plain-inline-secret',
              'https://args.example/mcp?token=plain-query-secret&token=second-query-secret',
            ],
            env: { API_TOKEN: 'encrypted-env-secret' },
          },
        }),
      ]);

      const afterRecovery = rawStoredRow(isolated, 'mixed-wrong-key');
      new McpServersRepository(isolated, correctKey);
      expect(rawStoredRow(isolated, 'mixed-wrong-key')).toEqual(afterRecovery);
    });
  });

  it('recovers mixed secrets from corrupt metadata without wrong-key mutation or double encryption', () => {
    withIsolatedDatabase((isolated) => {
      const correctKey = randomBytes(32);
      const wrongKey = randomBytes(32);
      const encryptedCustomValue = encryptValue('encrypted-custom-secret', correctKey);
      insertStoredRow(isolated, {
        id: 'corrupt-secret-metadata',
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['--api-key=plain-inline-secret'],
          env: { CUSTOM_VALUE: encryptedCustomValue },
        },
        secretMetadata: '{malformed-json',
        sources: ['nuncio'],
      });
      const before = rawStoredRow(isolated, 'corrupt-secret-metadata');

      const wrongRepo = new McpServersRepository(isolated, wrongKey);
      const wrongService = new McpService(wrongRepo);
      expect(rawStoredRow(isolated, 'corrupt-secret-metadata')).toEqual(before);
      expect(wrongRepo.getRuntime('corrupt-secret-metadata')).toBeNull();
      const wrongApiJson = JSON.stringify({
        get: wrongService.get('corrupt-secret-metadata'),
        list: wrongService.list(),
      });
      expect(wrongApiJson).not.toContain('plain-inline-secret');
      expect(wrongApiJson).not.toContain(encryptedCustomValue);
      expect(wrongApiJson).toContain('••••');

      const recoveredRepo = new McpServersRepository(isolated, correctKey);
      expect(recoveredRepo.getRuntime('corrupt-secret-metadata')?.transport).toEqual({
        type: 'stdio',
        command: 'npx',
        args: ['--api-key=plain-inline-secret'],
        env: { CUSTOM_VALUE: 'encrypted-custom-secret' },
      });
      const recovered = rawStoredRow(isolated, 'corrupt-secret-metadata');
      expect(recovered?.transport_json).not.toContain('plain-inline-secret');
      expect(recovered?.transport_json).not.toContain('encrypted-custom-secret');
      expect(recovered?.transport_json.match(/v1:/g)).toHaveLength(2);
      expect(recovered?.secret_keys_json).toContain('CUSTOM_VALUE');
      expect(recovered?.secret_keys_json).toContain('secretArgIndexes');

      new McpServersRepository(isolated, correctKey);
      expect(rawStoredRow(isolated, 'corrupt-secret-metadata')).toEqual(recovered);
    });
  });

  it('keeps valid empty metadata distinct from corrupt metadata', () => {
    withIsolatedDatabase((isolated) => {
      const key = randomBytes(32);
      const transport: McpStdioTransport = {
        type: 'stdio',
        command: 'literal-prefix',
        args: [],
        env: { CUSTOM_VALUE: 'v1:not:really-ciphertext' },
      };
      insertStoredRow(isolated, {
        id: 'valid-empty-metadata',
        transport,
        secretMetadata: JSON.stringify([]),
        identity: transportIdentity(transport),
      });
      const before = rawStoredRow(isolated, 'valid-empty-metadata');

      const validEmptyRepo = new McpServersRepository(isolated, key);

      expect(rawStoredRow(isolated, 'valid-empty-metadata')?.transport_json).toBe(
        before?.transport_json,
      );
      expect(validEmptyRepo.getRuntime('valid-empty-metadata')?.transport).toEqual(transport);
      expect(validEmptyRepo.get('valid-empty-metadata')?.secretKeys).toEqual([]);
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

  it('rejects credential-bearing remote URLs on direct create and update without persisting them', () => {
    expect(() =>
      repo.create({
        name: 'userinfo-create',
        transport: { type: 'http', url: 'https://alice:create-secret@remote.example/mcp' },
      }),
    ).toThrow(/username|password|credentials/i);
    expect(repo.list().some((server) => server.name === 'userinfo-create')).toBe(false);

    const existing = repo.create({
      name: 'userinfo-update',
      transport: { type: 'http', url: 'https://remote.example/original' },
    });
    expect(() =>
      repo.update(existing.id, {
        transport: { type: 'sse', url: 'https://bob:update-secret@remote.example/mcp' },
      }),
    ).toThrow(/username|password|credentials/i);
    expect(repo.get(existing.id)?.transport).toEqual({
      type: 'http',
      url: 'https://remote.example/original',
    });

    const rawTransports = database.db
      .prepare<{ transport_json: string }, []>('SELECT transport_json FROM mcp_servers')
      .all()
      .map((row) => row.transport_json)
      .join('\n');
    expect(rawTransports).not.toContain('create-secret');
    expect(rawTransports).not.toContain('update-secret');
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

interface ImportedRowFixture {
  id: string;
  transport: unknown;
  secretMetadata: string;
  identity: string;
}

interface StoredRowFixture {
  id: string;
  transport: unknown;
  secretMetadata?: string;
  identity?: string;
  sources?: string[];
  auth?: 'none' | 'oauth';
  enabled?: boolean;
}

function insertImportedRow(database: DatabaseService, fixture: ImportedRowFixture): void {
  insertStoredRow(database, {
    ...fixture,
    sources: ['import:cursor'],
  });
}

function insertStoredRow(database: DatabaseService, fixture: StoredRowFixture): void {
  const now = Date.now();
  database.db
    .prepare(
      `INSERT INTO mcp_servers (
        id, name, description, transport_json, enabled, advertise, project_path,
        engines_json, auth, sources_json, secret_keys_json, identity, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fixture.id,
      fixture.id,
      null,
      JSON.stringify(fixture.transport),
      fixture.enabled === false ? 0 : 1,
      'lazy',
      null,
      null,
      fixture.auth ?? 'none',
      JSON.stringify(fixture.sources ?? ['nuncio']),
      fixture.secretMetadata ?? JSON.stringify([]),
      fixture.identity ?? `legacy:${fixture.id}`,
      now,
      now,
    );
}

function rawStoredRow(database: DatabaseService, id: string) {
  return database.db
    .prepare<
      { transport_json: string; secret_keys_json: string; identity: string; enabled: number },
      [string]
    >(
      'SELECT transport_json, secret_keys_json, identity, enabled FROM mcp_servers WHERE id = ?',
    )
    .get(id);
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function withIsolatedDatabase(run: (database: DatabaseService) => void): void {
  const isolatedDir = mkdtempSync(join(tmpdir(), 'nuncio-mcp-migration-'));
  const previousDataDir = process.env.NUNCIO_DATA_DIR;
  process.env.NUNCIO_DATA_DIR = isolatedDir;
  const isolated = new DatabaseService();
  try {
    run(isolated);
  } finally {
    isolated.onModuleDestroy();
    rmSync(isolatedDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.NUNCIO_DATA_DIR;
    else process.env.NUNCIO_DATA_DIR = previousDataDir;
  }
}
