import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpTransport } from '../domain/mcp.types';
import { McpServersRepository } from '../persistence/mcp-servers.repository';
import { McpOAuthRepository } from '../persistence/mcp-oauth.repository';
import { NuncioMcpOAuthProvider } from './nuncio-mcp-oauth.provider';

export type McpOAuthStatus = 'none' | 'required' | 'connected';

export interface McpOAuthStartResult {
  authorizationUrl?: string;
  alreadyAuthorized?: boolean;
}

/** Orchestrates Nuncio-side OAuth for remote MCP servers. */
@Injectable()
export class McpOAuthService {
  private poolInvalidate?: (transport: McpTransport) => void;

  constructor(
    private readonly servers: McpServersRepository,
    private readonly oauth: McpOAuthRepository,
  ) {}

  /** Bridge registers its pool invalidator so finish() drops stale clients. */
  registerPoolInvalidator(fn: (transport: McpTransport) => void): void {
    this.poolInvalidate = fn;
  }

  oauthStatus(serverId: string, auth: 'none' | 'oauth'): McpOAuthStatus {
    if (auth !== 'oauth') return 'none';
    return this.oauth.hasTokens(serverId) ? 'connected' : 'required';
  }

  hasTokens(serverId: string): boolean {
    return this.oauth.hasTokens(serverId);
  }

  providerFor(serverId: string, redirectUri?: string): OAuthClientProvider {
    const uri = redirectUri ?? this.oauth.get(serverId)?.redirectUri;
    if (!uri) {
      throw new BadRequestException('OAuth redirect URI is not configured for this server');
    }
    return new NuncioMcpOAuthProvider(serverId, uri, this.oauth);
  }

  async start(serverId: string, redirectOrigin: string): Promise<McpOAuthStartResult> {
    const server = this.servers.get(serverId);
    if (!server) throw new NotFoundException(`unknown MCP server: ${serverId}`);
    if (server.auth !== 'oauth') {
      throw new BadRequestException('server does not use OAuth');
    }
    if (server.transport.type === 'stdio') {
      throw new BadRequestException('OAuth applies only to remote MCP transports');
    }
    if (this.oauth.hasTokens(serverId)) {
      return { alreadyAuthorized: true };
    }

    const redirectUri = `${redirectOrigin.replace(/\/+$/, '')}/api/mcp/oauth/callback`;
    const authProvider = new NuncioMcpOAuthProvider(serverId, redirectUri, this.oauth);
    const sdkTransport = buildRemoteTransport(server.transport, authProvider);
    const client = new Client({ name: 'nuncio-mcp-oauth', version: '1.0.0' });
    try {
      await client.connect(sdkTransport);
      await client.close();
      if (this.oauth.hasTokens(serverId)) {
        return { alreadyAuthorized: true };
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        const url = authProvider.pendingAuthorizationUrl;
        if (!url) throw new BadRequestException('OAuth server did not return an authorization URL');
        return { authorizationUrl: url };
      }
      throw error;
    }
    const url = authProvider.pendingAuthorizationUrl;
    if (url) return { authorizationUrl: url };
    throw new BadRequestException('OAuth flow did not produce an authorization URL');
  }

  async finish(state: string, code: string): Promise<string> {
    const row = this.oauth.findByState(state);
    if (!row) throw new BadRequestException('unknown or expired OAuth state');
    const server = this.servers.get(row.serverId);
    if (!server || server.transport.type === 'stdio') {
      throw new BadRequestException('invalid OAuth server');
    }
    const authProvider = new NuncioMcpOAuthProvider(row.serverId, row.redirectUri!, this.oauth);
    const sdkTransport = buildRemoteTransport(server.transport, authProvider);
    if (sdkTransport instanceof StreamableHTTPClientTransport) {
      await sdkTransport.finishAuth(code);
    } else {
      await sdkTransport.finishAuth(code);
    }
    this.poolInvalidate?.(server.transport);
    return row.serverId;
  }
}

function buildRemoteTransport(
  transport: McpTransport,
  authProvider: OAuthClientProvider,
): StreamableHTTPClientTransport | SSEClientTransport {
  if (transport.type === 'stdio') {
    throw new BadRequestException('OAuth applies only to remote MCP transports');
  }
  const url = new URL(transport.url);
  const requestInit = transport.headers ? { headers: transport.headers } : undefined;
  if (transport.type === 'sse') {
    return new SSEClientTransport(url, { ...(requestInit ? { requestInit } : {}), authProvider });
  }
  return new StreamableHTTPClientTransport(url, {
    ...(requestInit ? { requestInit } : {}),
    authProvider,
  });
}
