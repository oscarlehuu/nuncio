import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpOAuthRepository } from '../persistence/mcp-oauth.repository';

/** SDK OAuth provider that persists state in SQLite instead of opening a browser. */
export class NuncioMcpOAuthProvider implements OAuthClientProvider {
  pendingAuthorizationUrl: string | null = null;

  constructor(
    private readonly serverId: string,
    private readonly redirectUri: string,
    private readonly repo: McpOAuthRepository,
  ) {}

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'nuncio',
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  async state(): Promise<string> {
    const value = randomBytes(16).toString('hex');
    this.repo.upsert(this.serverId, { state: value, redirectUri: this.redirectUri });
    return value;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.repo.get(this.serverId)?.clientInfo ?? undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.repo.upsert(this.serverId, { clientInfo: clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.repo.get(this.serverId)?.tokens ?? undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.repo.upsert(this.serverId, { tokens, codeVerifier: null, state: null });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.pendingAuthorizationUrl = authorizationUrl.toString();
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.repo.upsert(this.serverId, { codeVerifier });
  }

  codeVerifier(): string {
    const value = this.repo.get(this.serverId)?.codeVerifier;
    if (!value) throw new Error('missing OAuth code verifier');
    return value;
  }
}
