import { BadRequestException, Injectable } from '@nestjs/common';
import { resolve as resolvePath } from 'node:path';
import { maskSecret } from '../settings/settings.crypto';
import { McpServersRepository } from './persistence/mcp-servers.repository';
import { isMcpEngineId } from './domain/mcp.types';
import type {
  CreateMcpServerInput,
  McpServerDefinition,
  McpServerDto,
  McpTransport,
  UpdateMcpServerInput,
} from './domain/mcp.types';

export interface McpSessionScope {
  provider: string;
  projectPath: string | null;
}

/**
 * Registry logic above the repository: per-session resolution (scope + engine
 * filters) for the bridge, and masked DTO mapping + validation for the API.
 */
@Injectable()
export class McpService {
  constructor(private readonly repo: McpServersRepository) {}

  /** Enabled servers a session may use: global rows + rows scoped to its project. */
  resolveForSession(scope: McpSessionScope): McpServerDefinition[] {
    const projectPath = scope.projectPath ? normalizePath(scope.projectPath) : null;
    return this.repo.list().filter((server) => {
      if (!server.enabled) return false;
      if (server.engines && !server.engines.includes(scope.provider as never)) return false;
      if (server.projectPath === null) return true;
      return projectPath !== null && normalizePath(server.projectPath) === projectPath;
    });
  }

  list(): McpServerDto[] {
    return this.repo.list().map((server) => this.toDto(server));
  }

  get(id: string): McpServerDto | null {
    const server = this.repo.get(id);
    return server ? this.toDto(server) : null;
  }

  /** Unmasked definition for runtime consumers (the bridge needs real secrets to connect). */
  getDefinition(id: string): McpServerDefinition | null {
    return this.repo.get(id);
  }

  create(input: CreateMcpServerInput): McpServerDto {
    this.validateTransport(input.transport);
    this.validateEngines(input.engines);
    return this.toDto(this.repo.create(input));
  }

  update(id: string, patch: UpdateMcpServerInput): McpServerDto | null {
    if (patch.transport) this.validateTransport(patch.transport);
    this.validateEngines(patch.engines);
    const existing = this.repo.get(id);
    if (!existing) return null;
    const effective = patch.transport
      ? { ...patch, transport: this.restoreMaskedSecrets(patch.transport, existing) }
      : patch;
    const updated = this.repo.update(id, effective);
    return updated ? this.toDto(updated) : null;
  }

  delete(id: string): boolean {
    return this.repo.delete(id);
  }

  private toDto(server: McpServerDefinition): McpServerDto {
    return {
      ...server,
      transport: mapSecretValues(server.transport, server.secretKeys, (value) =>
        maskSecret(value) ?? '',
      ),
      scope: server.projectPath === null ? 'global' : 'project',
    };
  }

  /**
   * The API returns masked secret values (`••••last4`); an editor that sends the
   * masked value back means "keep the stored secret", so swap the stored
   * plaintext back in before persisting.
   */
  private restoreMaskedSecrets(
    incoming: McpTransport,
    existing: McpServerDefinition,
  ): McpTransport {
    const storedValues = collectSecretValues(existing.transport, existing.secretKeys);
    return mapSecretValues(incoming, existing.secretKeys, (value, key) => {
      const stored = storedValues.get(key);
      return stored !== undefined && value === maskSecret(stored) ? stored : value;
    });
  }

  private validateTransport(transport: McpTransport): void {
    if (transport.type === 'stdio') {
      if (!transport.command?.trim()) {
        throw new BadRequestException('stdio transport requires a command');
      }
      return;
    }
    try {
      new URL(transport.url);
    } catch {
      throw new BadRequestException(`invalid transport url: ${transport.url}`);
    }
  }

  private validateEngines(engines: CreateMcpServerInput['engines']): void {
    for (const engine of engines ?? []) {
      if (!isMcpEngineId(engine)) {
        throw new BadRequestException(`unknown engine id: ${engine}`);
      }
    }
  }
}

function normalizePath(path: string): string {
  return resolvePath(path).replace(/\/+$/, '');
}

function mapSecretValues(
  transport: McpTransport,
  secretKeys: string[],
  fn: (value: string, key: string) => string,
): McpTransport {
  const secretSet = new Set(secretKeys);
  const mapRecord = (record: Record<string, string> | undefined) =>
    record
      ? Object.fromEntries(
          Object.entries(record).map(([key, value]) => [
            key,
            secretSet.has(key) ? fn(value, key) : value,
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

function collectSecretValues(transport: McpTransport, secretKeys: string[]): Map<string, string> {
  const record = transport.type === 'stdio' ? transport.env : transport.headers;
  const secretSet = new Set(secretKeys);
  return new Map(
    Object.entries(record ?? {}).filter(([key]) => secretSet.has(key)),
  );
}
