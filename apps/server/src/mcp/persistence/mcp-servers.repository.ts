import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import { decryptValue, encryptValue, isEncrypted } from '../../settings/settings.crypto';
import {
  mapTransportSecrets,
  mergeSecretMetadata,
  normalizeSecretMetadata,
  parseStoredSecretMetadata,
  serializeSecretMetadata,
  type McpSecretMetadata,
  type ParsedMcpSecretMetadata,
} from '../domain/mcp-secret-metadata';
import { hasRemoteUrlUserinfo, transportIdentity } from '../domain/mcp-transport';
import { detectTransportSecrets } from '../import/json-mcp-entry';
import { establishMcpSettingsKeyTrust } from './mcp-settings-key-verifier';
import type {
  CreateMcpServerInput,
  McpServerDefinition,
  McpServerSource,
  McpTransport,
  UpdateMcpServerInput,
} from '../domain/mcp.types';

/** AES-256-GCM key for secret transport values — same key file as the settings store. */
export const MCP_SETTINGS_KEY = Symbol('MCP_SETTINGS_KEY');

interface McpServerRow {
  id: string;
  name: string;
  description: string | null;
  transport_json: string;
  enabled: number;
  advertise: string;
  project_path: string | null;
  engines_json: string | null;
  auth: string;
  sources_json: string;
  secret_keys_json: string;
  identity: string;
  created_at: number;
  updated_at: number;
}

const ROW_COLUMNS =
  'id, name, description, transport_json, enabled, advertise, project_path, ' +
  'engines_json, auth, sources_json, secret_keys_json, identity, created_at, updated_at';

/**
 * SQL CRUD for the `mcp_servers` table. Unlike the dumb settings repository,
 * this one owns the transport (de)serialization including in-place secret
 * encryption, so every consumer gets a usable plaintext definition and no
 * caller can accidentally persist a raw secret.
 */
@Injectable()
export class McpServersRepository {
  constructor(
    private readonly database: DatabaseService,
    @Inject(MCP_SETTINGS_KEY) private readonly key: Buffer,
  ) {
    this.hardenStoredRows();
  }

  create(input: CreateMcpServerInput): McpServerDefinition {
    assertNoRemoteUrlUserinfo(input.transport);
    const now = Date.now();
    const id = this.uniqueId(input.name);
    const secrets = mergeSecretMetadata(
      normalizeSecretMetadata(input),
      detectTransportSecrets(input.transport),
    );
    const transportJson = JSON.stringify(this.sealTransport(input.transport, secrets));
    this.database.db
      .prepare(
        `INSERT INTO mcp_servers (${ROW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.description ?? null,
        transportJson,
        input.enabled === false ? 0 : 1,
        input.advertise ?? 'lazy',
        input.projectPath ?? null,
        input.engines ? JSON.stringify(input.engines) : null,
        input.auth ?? 'none',
        JSON.stringify(input.sources ?? ['nuncio']),
        serializeSecretMetadata(secrets),
        transportIdentity(input.transport),
        now,
        now,
      );
    const created = this.get(id);
    if (!created) throw new Error(`mcp_servers insert failed for ${id}`);
    return created;
  }

  get(id: string): McpServerDefinition | null {
    const row = this.database.db
      .prepare<McpServerRow, [string]>(`SELECT ${ROW_COLUMNS} FROM mcp_servers WHERE id = ?`)
      .get(id);
    return row ? this.toDefinition(row) : null;
  }

  /** Runtime reads omit rows whose credentials cannot be decrypted or safely migrated. */
  getRuntime(id: string): McpServerDefinition | null {
    const row = this.database.db
      .prepare<McpServerRow, [string]>(`SELECT ${ROW_COLUMNS} FROM mcp_servers WHERE id = ?`)
      .get(id);
    return row ? this.toRuntimeDefinition(row) : null;
  }

  list(): McpServerDefinition[] {
    return this.rowsOrderedByName().map((row) => this.toDefinition(row));
  }

  /** Runtime list is fail-closed per row while API list remains available and masked. */
  listRuntime(): McpServerDefinition[] {
    return this.rowsOrderedByName().flatMap((row) => {
      const definition = this.toRuntimeDefinition(row);
      return definition ? [definition] : [];
    });
  }

  update(id: string, patch: UpdateMcpServerInput): McpServerDefinition | null {
    const existing = this.getRuntime(id);
    if (!existing) return null;
    const transport = patch.transport ?? existing.transport;
    const secrets = mergeSecretMetadata(
      normalizeSecretMetadata({
        secretKeys: patch.secretKeys ?? existing.secretKeys,
        secretArgIndexes: patch.secretArgIndexes ?? existing.secretArgIndexes,
        secretUrlQueryKeys: patch.secretUrlQueryKeys ?? existing.secretUrlQueryKeys,
      }),
      detectTransportSecrets(transport),
    );
    assertNoRemoteUrlUserinfo(transport);
    this.database.db
      .prepare(
        `UPDATE mcp_servers SET
           name = ?, description = ?, transport_json = ?, enabled = ?, advertise = ?,
           project_path = ?, engines_json = ?, auth = ?, secret_keys_json = ?, identity = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.name ?? existing.name,
        patch.description !== undefined ? patch.description : existing.description,
        JSON.stringify(this.sealTransport(transport, secrets)),
        (patch.enabled ?? existing.enabled) ? 1 : 0,
        patch.advertise ?? existing.advertise,
        patch.projectPath !== undefined ? patch.projectPath : existing.projectPath,
        toJsonOrNull(patch.engines !== undefined ? patch.engines : existing.engines),
        patch.auth ?? existing.auth,
        serializeSecretMetadata(secrets),
        transportIdentity(transport),
        Date.now(),
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.database.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0;
  }

  findByIdentity(identity: string, projectPath: string | null): McpServerDefinition | null {
    const row = this.database.db
      .prepare<McpServerRow, [string, string]>(
        `SELECT ${ROW_COLUMNS} FROM mcp_servers WHERE identity = ? AND ifnull(project_path, '') = ?`,
      )
      .get(identity, projectPath ?? '');
    if (row) return this.toDefinition(row);

    // Pre-hardening rows stored the raw identity. Compare their decrypted
    // transports so existing installs do not create duplicates after the hash change.
    const scoped = this.database.db
      .prepare<McpServerRow, [string]>(
        `SELECT ${ROW_COLUMNS} FROM mcp_servers WHERE ifnull(project_path, '') = ?`,
      )
      .all(projectPath ?? '');
    for (const candidate of scoped) {
      const definition = this.toRuntimeDefinition(candidate);
      if (definition && transportIdentity(definition.transport) === identity) return definition;
    }
    return null;
  }

  addSource(id: string, source: McpServerSource): void {
    const existing = this.get(id);
    if (!existing || existing.sources.includes(source)) return;
    this.database.db
      .prepare('UPDATE mcp_servers SET sources_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify([...existing.sources, source]), Date.now(), id);
  }

  /**
   * Compatibility rewrite for rows created before all credential locations were
   * encrypted. Credential rewrites are all-or-nothing: one bad ciphertext keeps
   * the row recoverable under the correct key. URL userinfo is the exception —
   * it can be stripped into a disabled quarantine without changing ciphertext.
   */
  private hardenStoredRows(): void {
    let rows: McpServerRow[];
    try {
      rows = this.database.db.prepare<McpServerRow, []>(`SELECT ${ROW_COLUMNS} FROM mcp_servers`).all();
    } catch {
      return;
    }
    const migrationKeyTrusted = establishMcpSettingsKeyTrust(
      this.database,
      this.key,
      collectMcpKeyEvidence(rows),
    );
    for (const row of rows) {
      try {
        const parsedSecrets = parseStoredSecretMetadata(row.secret_keys_json);
        const storedTransport = JSON.parse(row.transport_json) as McpTransport;
        let secrets = metadataForStoredTransport(storedTransport, parsedSecrets);
        const rowKeyValidated = hasMarkedCiphertext(storedTransport, secrets);
        let transport = this.unsealTransportStrict(storedTransport, secrets);
        secrets = mergeSecretMetadata(secrets, detectTransportSecrets(transport));
        let enabled = row.enabled;
        const hadRemoteUserinfo =
          transport.type !== 'stdio' && hasRemoteUrlUserinfo(transport.url);

        if (hadRemoteUserinfo && transport.type !== 'stdio') {
          const migrated = migrateRemoteUserinfo(transport, row.auth);
          transport = migrated.transport;
          enabled = migrated.compatible ? row.enabled : 0;
          if (migrated.authorizationAdded) {
            secrets = mergeSecretMetadata(secrets, { secretKeys: ['Authorization'] });
          }
        }

        if (
          !migrationKeyTrusted &&
          !rowKeyValidated &&
          (hadRemoteUserinfo || hasMarkedValues(transport, secrets))
        ) {
          continue;
        }

        const identity = transportIdentity(transport);
        const serializedSecrets = serializeSecretMetadata(secrets);
        if (
          row.identity === identity &&
          row.secret_keys_json === serializedSecrets &&
          row.enabled === enabled &&
          this.areMarkedValuesEncrypted(storedTransport, secrets)
        ) {
          continue;
        }
        this.database.db
          .prepare(
            `UPDATE mcp_servers
             SET transport_json = ?, secret_keys_json = ?, identity = ?, enabled = ?
             WHERE id = ?`,
          )
          .run(
            JSON.stringify(this.sealTransport(transport, secrets)),
            serializedSecrets,
            identity,
            enabled,
            row.id,
          );
      } catch {
        // Preserve ciphertext bytes. URL userinfo is independently removable, so
        // quarantine that row even when another credential cannot be decrypted.
        // Other rows stay byte-identical for a later correct-key recovery.
        this.quarantineUnreadableRemoteUserinfo(row);
      }
    }
  }

  private quarantineUnreadableRemoteUserinfo(row: McpServerRow): void {
    try {
      const stored = JSON.parse(row.transport_json) as McpTransport;
      if (stored.type === 'stdio' || !hasRemoteUrlUserinfo(stored.url)) return;
      const transport = { ...stored, url: stripRemoteUrlUserinfo(stored.url) };
      this.database.db
        .prepare(
          `UPDATE mcp_servers
           SET transport_json = ?, identity = ?, enabled = 0
           WHERE id = ?`,
        )
        .run(JSON.stringify(transport), transportIdentity(transport), row.id);
    } catch {
      // Malformed rows remain unavailable through runtime reads.
    }
  }

  private areMarkedValuesEncrypted(
    transport: McpTransport,
    secrets: McpSecretMetadata,
  ): boolean {
    let encrypted = true;
    mapTransportSecrets(transport, secrets, (value) => {
      if (!isEncrypted(value)) encrypted = false;
      return value;
    });
    return encrypted;
  }

  private rowsOrderedByName(): McpServerRow[] {
    return this.database.db
      .prepare<McpServerRow, []>(
        `SELECT ${ROW_COLUMNS} FROM mcp_servers ORDER BY name COLLATE NOCASE ASC`,
      )
      .all();
  }

  private toDefinition(row: McpServerRow): McpServerDefinition {
    return this.readDefinition(row, false)!;
  }

  private toRuntimeDefinition(row: McpServerRow): McpServerDefinition | null {
    return this.readDefinition(row, true);
  }

  private readDefinition(
    row: McpServerRow,
    runtimeOnly: boolean,
  ): McpServerDefinition | null {
    const storedTransport = JSON.parse(row.transport_json) as McpTransport;
    const parsedSecrets = parseStoredSecretMetadata(row.secret_keys_json);
    const secrets = metadataForStoredTransport(storedTransport, parsedSecrets);
    let runtimeSafe = true;
    let transport = mapTransportSecrets(storedTransport, secrets, (value) => {
      if (!isEncrypted(value)) {
        runtimeSafe = false;
        return value;
      }
      try {
        return decryptValue(value, this.key);
      } catch {
        runtimeSafe = false;
        return '';
      }
    });
    if (transport.type !== 'stdio' && hasRemoteUrlUserinfo(transport.url)) {
      runtimeSafe = false;
      transport = { ...transport, url: stripRemoteUrlUserinfo(transport.url) };
    }
    if (runtimeOnly && !runtimeSafe) return null;

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      transport,
      enabled: row.enabled === 1,
      advertise: row.advertise as McpServerDefinition['advertise'],
      projectPath: row.project_path,
      engines: row.engines_json
        ? (JSON.parse(row.engines_json) as McpServerDefinition['engines'])
        : null,
      auth: row.auth as McpServerDefinition['auth'],
      sources: JSON.parse(row.sources_json) as McpServerSource[],
      ...secrets,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Encrypt every marked value unconditionally, including `v1:`-prefixed plaintext. */
  private sealTransport(transport: McpTransport, secrets: McpSecretMetadata): McpTransport {
    return mapTransportSecrets(transport, secrets, (value) => encryptValue(value, this.key));
  }

  /** Migration reads are all-or-nothing: one bad ciphertext must prevent every row write. */
  private unsealTransportStrict(
    transport: McpTransport,
    secrets: McpSecretMetadata,
  ): McpTransport {
    return mapTransportSecrets(transport, secrets, (value) =>
      isEncrypted(value) ? decryptValue(value, this.key) : value,
    );
  }

  private uniqueId(name: string): string {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'server';
    let candidate = base;
    for (let n = 2; this.exists(candidate); n += 1) candidate = `${base}-${n}`;
    return candidate;
  }

  private exists(id: string): boolean {
    return (
      this.database.db
        .prepare<{ id: string }, [string]>('SELECT id FROM mcp_servers WHERE id = ?')
        .get(id) != null
    );
  }
}

function collectMcpKeyEvidence(rows: McpServerRow[]): {
  ciphertexts: string[];
  hasUnverifiablePlaintextSecrets: boolean;
} {
  const ciphertexts: string[] = [];
  let hasUnverifiablePlaintextSecrets = false;
  for (const row of rows) {
    try {
      const transport = JSON.parse(row.transport_json) as McpTransport;
      const metadata = metadataForStoredTransport(
        transport,
        parseStoredSecretMetadata(row.secret_keys_json),
      );
      mapTransportSecrets(transport, metadata, (value) => {
        if (isEncrypted(value)) ciphertexts.push(value);
        else hasUnverifiablePlaintextSecrets = true;
        return value;
      });
      if (transport.type !== 'stdio' && hasRemoteUrlUserinfo(transport.url)) {
        hasUnverifiablePlaintextSecrets = true;
      }
    } catch {
      hasUnverifiablePlaintextSecrets = true;
    }
  }
  return { ciphertexts, hasUnverifiablePlaintextSecrets };
}

function hasMarkedCiphertext(
  transport: McpTransport,
  metadata: McpSecretMetadata,
): boolean {
  let found = false;
  mapTransportSecrets(transport, metadata, (value) => {
    if (isEncrypted(value)) found = true;
    return value;
  });
  return found;
}

function hasMarkedValues(transport: McpTransport, metadata: McpSecretMetadata): boolean {
  let found = false;
  mapTransportSecrets(transport, metadata, (value) => {
    found = true;
    return value;
  });
  return found;
}

function metadataForStoredTransport(
  transport: McpTransport,
  parsed: ParsedMcpSecretMetadata,
): McpSecretMetadata {
  let metadata = mergeSecretMetadata(parsed.metadata, detectTransportSecrets(transport));
  if (parsed.status === 'corrupt') {
    metadata = mergeSecretMetadata(metadata, inferEncryptedSecretMetadata(transport));
  }
  return metadata;
}

function inferEncryptedSecretMetadata(transport: McpTransport): McpSecretMetadata {
  if (transport.type === 'stdio') {
    return normalizeSecretMetadata({
      secretKeys: Object.entries(transport.env ?? {})
        .filter(([, value]) => isEncrypted(value))
        .map(([key]) => key),
      secretArgIndexes: transport.args.flatMap((value, index) =>
        isEncrypted(value) ? [index] : [],
      ),
    });
  }

  const secretKeys = Object.entries(transport.headers ?? {})
    .filter(([, value]) => isEncrypted(value))
    .map(([key]) => key);
  const secretUrlQueryKeys: string[] = [];
  try {
    const parsed = new URL(transport.url);
    for (const [key, value] of parsed.searchParams) {
      if (isEncrypted(value)) secretUrlQueryKeys.push(key);
    }
  } catch {
    // Invalid legacy URLs remain fail-closed through normal runtime validation.
  }
  return normalizeSecretMetadata({ secretKeys, secretUrlQueryKeys });
}

type McpRemoteTransport = Exclude<McpTransport, { type: 'stdio' }>;

function migrateRemoteUserinfo(
  transport: McpRemoteTransport,
  auth: string,
): {
  transport: McpRemoteTransport;
  compatible: boolean;
  authorizationAdded: boolean;
} {
  const parsed = new URL(transport.url);
  const encodedUsername = parsed.username;
  const encodedPassword = parsed.password;
  parsed.username = '';
  parsed.password = '';
  const sanitized = { ...transport, url: parsed.toString() };
  const hasAuthorization = Object.keys(transport.headers ?? {}).some(
    (key) => key.toLowerCase() === 'authorization',
  );
  if (
    auth !== 'none' ||
    hasAuthorization ||
    !['http:', 'https:'].includes(parsed.protocol)
  ) {
    return { transport: sanitized, compatible: false, authorizationAdded: false };
  }

  try {
    const username = decodeURIComponent(encodedUsername);
    const password = decodeURIComponent(encodedPassword);
    if (username.includes(':')) {
      return { transport: sanitized, compatible: false, authorizationAdded: false };
    }
    const authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    return {
      transport: {
        ...sanitized,
        headers: { ...(transport.headers ?? {}), Authorization: authorization },
      },
      compatible: true,
      authorizationAdded: true,
    };
  } catch {
    return { transport: sanitized, compatible: false, authorizationAdded: false };
  }
}

function stripRemoteUrlUserinfo(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return 'about:blank';
  }
}

function assertNoRemoteUrlUserinfo(transport: McpTransport): void {
  if (transport.type !== 'stdio' && hasRemoteUrlUserinfo(transport.url)) {
    throw new Error('MCP remote URL must not include a username or password');
  }
}

/** JSON.stringify that maps null/undefined input to a SQL NULL. */
function toJsonOrNull(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}
