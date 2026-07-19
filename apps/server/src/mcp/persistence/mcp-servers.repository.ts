import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import { decryptValue, encryptValue, isEncrypted } from '../../settings/settings.crypto';
import { transportIdentity } from '../domain/mcp-transport';
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
  ) {}

  create(input: CreateMcpServerInput): McpServerDefinition {
    const now = Date.now();
    const id = this.uniqueId(input.name);
    const secretKeys = input.secretKeys ?? [];
    const transportJson = JSON.stringify(this.sealTransport(input.transport, secretKeys));
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
        JSON.stringify(secretKeys),
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

  list(): McpServerDefinition[] {
    return this.database.db
      .prepare<McpServerRow, []>(
        `SELECT ${ROW_COLUMNS} FROM mcp_servers ORDER BY name COLLATE NOCASE ASC`,
      )
      .all()
      .map((row) => this.toDefinition(row));
  }

  update(id: string, patch: UpdateMcpServerInput): McpServerDefinition | null {
    const existing = this.get(id);
    if (!existing) return null;
    const secretKeys = patch.secretKeys ?? existing.secretKeys;
    const transport = patch.transport ?? existing.transport;
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
        JSON.stringify(this.sealTransport(transport, secretKeys)),
        (patch.enabled ?? existing.enabled) ? 1 : 0,
        patch.advertise ?? existing.advertise,
        patch.projectPath !== undefined ? patch.projectPath : existing.projectPath,
        toJsonOrNull(patch.engines !== undefined ? patch.engines : existing.engines),
        patch.auth ?? existing.auth,
        JSON.stringify(secretKeys),
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
    return row ? this.toDefinition(row) : null;
  }

  addSource(id: string, source: McpServerSource): void {
    const existing = this.get(id);
    if (!existing || existing.sources.includes(source)) return;
    this.database.db
      .prepare('UPDATE mcp_servers SET sources_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify([...existing.sources, source]), Date.now(), id);
  }

  private toDefinition(row: McpServerRow): McpServerDefinition {
    const secretKeys = JSON.parse(row.secret_keys_json) as string[];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      transport: this.unsealTransport(JSON.parse(row.transport_json) as McpTransport, secretKeys),
      enabled: row.enabled === 1,
      advertise: row.advertise as McpServerDefinition['advertise'],
      projectPath: row.project_path,
      engines: row.engines_json
        ? (JSON.parse(row.engines_json) as McpServerDefinition['engines'])
        : null,
      auth: row.auth as McpServerDefinition['auth'],
      sources: JSON.parse(row.sources_json) as McpServerSource[],
      secretKeys,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private sealTransport(transport: McpTransport, secretKeys: string[]): McpTransport {
    return this.mapSecretValues(transport, secretKeys, (value) =>
      isEncrypted(value) ? value : encryptValue(value, this.key),
    );
  }

  private unsealTransport(transport: McpTransport, secretKeys: string[]): McpTransport {
    return this.mapSecretValues(transport, secretKeys, (value) =>
      isEncrypted(value) ? decryptValue(value, this.key) : value,
    );
  }

  private mapSecretValues(
    transport: McpTransport,
    secretKeys: string[],
    fn: (value: string) => string,
  ): McpTransport {
    const secretSet = new Set(secretKeys);
    const mapRecord = (record: Record<string, string> | undefined) =>
      record
        ? Object.fromEntries(
            Object.entries(record).map(([key, value]) => [
              key,
              secretSet.has(key) ? fn(value) : value,
            ]),
          )
        : undefined;
    if (transport.type === 'stdio') {
      const env = mapRecord(transport.env);
      return { ...transport, ...(env ? { env } : {}) };
    }
    const headers = mapRecord(transport.headers);
    return { ...transport, ...(headers ? { headers } : {}) };
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

/** JSON.stringify that maps null/undefined input to a SQL NULL. */
function toJsonOrNull(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}
