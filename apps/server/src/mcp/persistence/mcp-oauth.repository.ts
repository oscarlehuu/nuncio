import { Inject, Injectable } from '@nestjs/common';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { DatabaseService } from '../../db/database.service';
import { decryptValue, encryptValue, isEncrypted } from '../../settings/settings.crypto';
import { MCP_SETTINGS_KEY } from './mcp-servers.repository';

export interface McpOAuthRow {
  serverId: string;
  tokens: OAuthTokens | null;
  clientInfo: OAuthClientInformationMixed | null;
  codeVerifier: string | null;
  state: string | null;
  redirectUri: string | null;
  updatedAt: number;
}

interface McpOAuthDbRow {
  server_id: string;
  tokens_json: string | null;
  client_info_json: string | null;
  code_verifier: string | null;
  state: string | null;
  redirect_uri: string | null;
  updated_at: number;
}

const ROW_COLUMNS =
  'server_id, tokens_json, client_info_json, code_verifier, state, redirect_uri, updated_at';

/** Encrypted OAuth session state for one MCP server row. */
@Injectable()
export class McpOAuthRepository {
  constructor(
    private readonly database: DatabaseService,
    @Inject(MCP_SETTINGS_KEY) private readonly key: Buffer,
  ) {}

  get(serverId: string): McpOAuthRow | null {
    const row = this.database.db
      .prepare<McpOAuthDbRow, [string]>(`SELECT ${ROW_COLUMNS} FROM mcp_oauth WHERE server_id = ?`)
      .get(serverId);
    return row ? this.toRow(row) : null;
  }

  findByState(state: string): McpOAuthRow | null {
    const row = this.database.db
      .prepare<McpOAuthDbRow, [string]>(`SELECT ${ROW_COLUMNS} FROM mcp_oauth WHERE state = ?`)
      .get(state);
    return row ? this.toRow(row) : null;
  }

  upsert(
    serverId: string,
    patch: Partial<
      Pick<McpOAuthRow, 'tokens' | 'clientInfo' | 'codeVerifier' | 'state' | 'redirectUri'>
    >,
  ): McpOAuthRow {
    const existing = this.get(serverId);
    const now = Date.now();
    const next: McpOAuthRow = {
      serverId,
      tokens: patch.tokens !== undefined ? patch.tokens : (existing?.tokens ?? null),
      clientInfo: patch.clientInfo !== undefined ? patch.clientInfo : (existing?.clientInfo ?? null),
      codeVerifier:
        patch.codeVerifier !== undefined ? patch.codeVerifier : (existing?.codeVerifier ?? null),
      state: patch.state !== undefined ? patch.state : (existing?.state ?? null),
      redirectUri:
        patch.redirectUri !== undefined ? patch.redirectUri : (existing?.redirectUri ?? null),
      updatedAt: now,
    };
    this.database.db
      .prepare(
        `INSERT INTO mcp_oauth (${ROW_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET
           tokens_json = excluded.tokens_json,
           client_info_json = excluded.client_info_json,
           code_verifier = excluded.code_verifier,
           state = excluded.state,
           redirect_uri = excluded.redirect_uri,
           updated_at = excluded.updated_at`,
      )
      .run(
        serverId,
        this.sealJson(next.tokens),
        this.sealJson(next.clientInfo),
        this.sealText(next.codeVerifier),
        next.state,
        next.redirectUri,
        now,
      );
    return this.get(serverId)!;
  }

  delete(serverId: string): boolean {
    return this.database.db.prepare('DELETE FROM mcp_oauth WHERE server_id = ?').run(serverId).changes > 0;
  }

  hasTokens(serverId: string): boolean {
    const row = this.get(serverId);
    return Boolean(row?.tokens?.access_token);
  }

  private toRow(row: McpOAuthDbRow): McpOAuthRow {
    return {
      serverId: row.server_id,
      tokens: this.unsealJson<OAuthTokens>(row.tokens_json),
      clientInfo: this.unsealJson<OAuthClientInformationMixed>(row.client_info_json),
      codeVerifier: this.unsealText(row.code_verifier),
      state: row.state,
      redirectUri: row.redirect_uri,
      updatedAt: row.updated_at,
    };
  }

  private sealJson(value: unknown): string | null {
    if (value == null) return null;
    return encryptValue(JSON.stringify(value), this.key);
  }

  private unsealJson<T>(stored: string | null): T | null {
    if (!stored) return null;
    const plaintext = this.unsealText(stored);
    if (!plaintext) return null;
    try {
      return JSON.parse(plaintext) as T;
    } catch {
      return null;
    }
  }

  private sealText(value: string | null): string | null {
    if (value == null) return null;
    return encryptValue(value, this.key);
  }

  private unsealText(stored: string | null): string | null {
    if (!stored) return null;
    if (!isEncrypted(stored)) return stored;
    try {
      return decryptValue(stored, this.key);
    } catch {
      return null;
    }
  }
}
