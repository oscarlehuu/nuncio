import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import { resolve as resolvePath } from 'node:path';
import { maskSecret } from '../settings/settings.crypto';
import { ProjectsRepository } from '../projects/projects.repository';
import { McpOAuthService } from './oauth/mcp-oauth.service';
import { McpServersRepository } from './persistence/mcp-servers.repository';
import {
  mapTransportSecrets,
  mergeSecretMetadata,
  normalizeSecretMetadata,
  type McpSecretLocation,
  type McpSecretMetadata,
} from './domain/mcp-secret-metadata';
import { hasRemoteUrlUserinfo, transportIdentity } from './domain/mcp-transport';
import { detectTransportSecrets } from './import/json-mcp-entry';
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
  /** Explicit session selection; null = inherit project/default; [] = none. */
  mcpServerIds?: string[] | null;
}

/**
 * Registry logic above the repository: per-session resolution (scope + engine
 * filters) for the bridge, and masked DTO mapping + validation for the API.
 */
@Injectable()
export class McpService {
  constructor(
    private readonly repo: McpServersRepository,
    @Optional() private readonly projects?: ProjectsRepository,
    @Optional() private readonly oauth?: McpOAuthService,
  ) {}

  /** Enabled servers a session may use: global rows + rows scoped to its project. */
  resolveForSession(scope: McpSessionScope): McpServerDefinition[] {
    const scoped = this.scopedServers(scope);
    const selectedIds = this.resolveSelectedIds(scope, scoped);
    if (selectedIds !== null) {
      const allowed = new Set(selectedIds);
      return scoped.filter((server) => allowed.has(server.id));
    }
    return scoped;
  }

  private scopedServers(scope: McpSessionScope): McpServerDefinition[] {
    const projectPath = scope.projectPath ? normalizePath(scope.projectPath) : null;
    return this.repo.listRuntime().filter((server) => {
      if (!server.enabled) return false;
      if (server.engines && !server.engines.includes(scope.provider as never)) return false;
      if (server.projectPath === null) return true;
      return projectPath !== null && normalizePath(server.projectPath) === projectPath;
    });
  }

  private resolveSelectedIds(
    scope: McpSessionScope,
    scoped: McpServerDefinition[],
  ): string[] | null {
    if (scope.mcpServerIds !== undefined && scope.mcpServerIds !== null) {
      return this.filterKnownIds(scope.mcpServerIds, scoped);
    }
    if (scope.projectPath && this.projects) {
      const project = this.projects.findByPath(scope.projectPath);
      if (project?.mcpServerIds !== undefined && project.mcpServerIds !== null) {
        return this.filterKnownIds(project.mcpServerIds, scoped);
      }
    }
    return null;
  }

  private filterKnownIds(ids: string[], scoped: McpServerDefinition[]): string[] {
    const known = new Set(scoped.map((server) => server.id));
    return ids.filter((id) => known.has(id));
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
    return this.repo.getRuntime(id);
  }

  create(input: CreateMcpServerInput): McpServerDto {
    const transport = this.normalizeAndValidate(input.transport);
    this.validateEngines(input.engines);
    this.assertNoIdentityConflict(transport, input.projectPath ?? null, null);
    const secrets = mergeSecretMetadata(
      normalizeSecretMetadata(input),
      detectTransportSecrets(transport),
    );
    return this.toDto(this.repo.create({ ...input, transport, ...secrets }));
  }

  update(id: string, patch: UpdateMcpServerInput): McpServerDto | null {
    this.validateEngines(patch.engines);
    const existing = this.repo.getRuntime(id);
    if (!existing) return null;
    const transport = patch.transport
      ? this.restoreMaskedSecrets(this.normalizeAndValidate(patch.transport), existing)
      : existing.transport;
    const projectPath =
      patch.projectPath !== undefined ? patch.projectPath : existing.projectPath;
    this.assertNoIdentityConflict(transport, projectPath, id);
    const guardedSecretKeys = this.guardDeclassification(patch, existing);
    const secrets = mergeSecretMetadata(
      normalizeSecretMetadata({
        secretKeys: guardedSecretKeys ?? existing.secretKeys,
        secretArgIndexes: patch.secretArgIndexes
          ? [...new Set([...(existing.secretArgIndexes ?? []), ...patch.secretArgIndexes])]
          : existing.secretArgIndexes,
        secretUrlQueryKeys: patch.secretUrlQueryKeys
          ? [
              ...new Set([
                ...(existing.secretUrlQueryKeys ?? []),
                ...patch.secretUrlQueryKeys,
              ]),
            ]
          : existing.secretUrlQueryKeys,
      }),
      detectTransportSecrets(transport),
    );
    const updated = this.repo.update(id, {
      ...patch,
      ...(patch.transport ? { transport } : {}),
      ...secrets,
    });
    return updated ? this.toDto(updated) : null;
  }

  delete(id: string): boolean {
    const deleted = this.repo.delete(id);
    if (deleted) this.oauth?.clear(id);
    return deleted;
  }

  private toDto(server: McpServerDefinition): McpServerDto {
    return {
      ...server,
      transport: maskTransportSecrets(
        server.transport,
        server.secretKeys,
        server.secretArgIndexes,
        server.secretUrlQueryKeys,
      ),
      scope: server.projectPath === null ? 'global' : 'project',
      oauthStatus: this.oauth?.oauthStatus(server.id, server.auth) ?? (server.auth === 'oauth' ? 'required' : 'none'),
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
    const metadata = normalizeSecretMetadata(existing);
    const storedByLocation = collectSecretValuesByLocation(existing.transport, metadata);
    const occurrenceByLocation = new Map<string, number>();
    return mapTransportSecrets(incoming, metadata, (value, location) => {
      const key = secretLocationKey(location);
      const occurrence = occurrenceByLocation.get(key) ?? 0;
      occurrenceByLocation.set(key, occurrence + 1);
      const stored = storedByLocation.get(key)?.[occurrence];
      return stored !== undefined && value === maskTransportValue(stored, location) ? stored : value;
    });
  }

  /**
   * Shrinking `secretKeys` must never declassify a stored secret: a key may
   * leave the set only when the same request supplies a fresh value for it
   * (i.e. not the masked placeholder), which the caller by definition knows.
   * Otherwise the key is silently retained as secret.
   */
  private guardDeclassification(
    patch: UpdateMcpServerInput,
    existing: McpServerDefinition,
  ): string[] | undefined {
    if (!patch.secretKeys) return undefined;
    const requested = patch.secretKeys;
    const retained = existing.secretKeys.filter((key) => {
      if (requested.includes(key)) return false; // already requested — not "retained"
      const stored = collectSecretValues(existing.transport, existing.secretKeys).get(key);
      const incoming = patch.transport ? secretValueFor(patch.transport, key) : undefined;
      const suppliedFresh =
        incoming !== undefined && stored !== undefined && incoming !== maskSecret(stored);
      return !suppliedFresh;
    });
    return [...new Set([...requested, ...retained])];
  }

  private assertNoIdentityConflict(
    transport: McpTransport,
    projectPath: string | null,
    selfId: string | null,
  ): void {
    const conflict = this.repo.findByIdentity(transportIdentity(transport), projectPath ?? null);
    if (conflict && conflict.id !== selfId) {
      throw new ConflictException(
        `this transport is already registered as "${conflict.id}" in the same scope`,
      );
    }
  }

  private normalizeAndValidate(transport: McpTransport): McpTransport {
    if (transport.type === 'stdio') {
      if (typeof transport.command !== 'string' || !transport.command.trim()) {
        throw new BadRequestException('stdio transport requires a command');
      }
      return { ...transport, args: Array.isArray(transport.args) ? transport.args : [] };
    }
    try {
      new URL(transport.url);
    } catch {
      throw new BadRequestException('invalid transport URL');
    }
    if (hasRemoteUrlUserinfo(transport.url)) {
      throw new BadRequestException('transport URL must not include a username or password');
    }
    return transport;
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

/** Replace every marked transport credential with a usable masked preview. */
export function maskTransportSecrets(
  transport: McpTransport,
  secretKeys: string[],
  secretArgIndexes: number[] = [],
  secretUrlQueryKeys: string[] = [],
): McpTransport {
  const metadata = normalizeSecretMetadata({
    secretKeys,
    secretArgIndexes,
    secretUrlQueryKeys,
  });
  return mapTransportSecrets(transport, metadata, maskTransportValue);
}

function maskTransportValue(value: string, location: McpSecretLocation): string {
  if (location.kind !== 'arg') return maskSecret(value) ?? '';
  const maskedUrl = maskEveryQueryValue(value);
  if (maskedUrl !== value) return maskedUrl;
  const equalsAt = value.indexOf('=');
  if (value.startsWith('-') && equalsAt > 0) {
    return `${value.slice(0, equalsAt + 1)}${maskSecret(value.slice(equalsAt + 1)) ?? ''}`;
  }
  return maskSecret(value) ?? '';
}

function maskEveryQueryValue(value: string): string {
  try {
    const parsed = new URL(value);
    const entries = [...parsed.searchParams.entries()];
    if (entries.length === 0) return value;
    parsed.search = '';
    for (const [key, secret] of entries) {
      parsed.searchParams.append(key, maskSecret(secret) ?? '');
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function collectSecretValuesByLocation(
  transport: McpTransport,
  metadata: McpSecretMetadata,
): Map<string, string[]> {
  const values = new Map<string, string[]>();
  mapTransportSecrets(transport, metadata, (value, location) => {
    const key = secretLocationKey(location);
    const existing = values.get(key);
    if (existing) existing.push(value);
    else values.set(key, [value]);
    return value;
  });
  return values;
}

function secretLocationKey(location: McpSecretLocation): string {
  switch (location.kind) {
    case 'record':
      return `record:${location.key}`;
    case 'arg':
      return `arg:${location.index}`;
    case 'url-query':
      return `url-query:${location.key}`;
    default: {
      const exhaustive: never = location;
      return exhaustive;
    }
  }
}

function collectSecretValues(transport: McpTransport, secretKeys: string[]): Map<string, string> {
  const record = transport.type === 'stdio' ? transport.env : transport.headers;
  const secretSet = new Set(secretKeys);
  return new Map(
    Object.entries(record ?? {}).filter(([key]) => secretSet.has(key)),
  );
}

function secretValueFor(transport: McpTransport, key: string): string | undefined {
  const record = transport.type === 'stdio' ? transport.env : transport.headers;
  return record?.[key];
}
