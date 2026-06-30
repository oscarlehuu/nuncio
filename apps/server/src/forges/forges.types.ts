export type ForgeAuthMethod = 'token' | 'cli';

export interface ForgeAuth {
  token: string;
  method: ForgeAuthMethod;
}

export interface ForgeUser {
  login: string;
  name: string | null;
}

export interface ForgeStatusDto {
  id: string;
  name: string;
  connected: boolean;
  method: ForgeAuthMethod | null;
  login: string | null;
}

export interface ForgeRepoRef {
  owner: string;
  repo: string;
}

export interface CreatePullRequestOptions {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface ForgeCheck {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface ForgePullRequest {
  number: number;
  url: string;
  state: string;
  title: string;
  /** Populated by getPullRequestForSession (refresh); omitted on create. */
  checks?: ForgeCheck[];
}

export interface ForgeWebhookEvent {
  provider: string;
  deliveryId: string;
  kind: 'issue' | 'pull_request';
  action: string;
  owner: string;
  repo: string;
  repoFullName: string;
  defaultBranch: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface ForgeProvider {
  readonly id: string;
  readonly name: string;
  isAvailable(): Promise<boolean>;
  resolveAuth(): Promise<ForgeAuth | null>;
  getCurrentUser(): Promise<ForgeUser>;
  createPullRequest(repo: ForgeRepoRef, opts: CreatePullRequestOptions): Promise<ForgePullRequest>;
  getPullRequest(repo: ForgeRepoRef, number: number): Promise<ForgePullRequest>;
  listChecks(repo: ForgeRepoRef, ref: string): Promise<ForgeCheck[]>;
  addComment(repo: ForgeRepoRef, number: number, body: string): Promise<void>;
  /** Verify an inbound webhook's signature over the exact raw request body. */
  verifyWebhookSignature(headers: Record<string, string | undefined>, rawBody: string): boolean;
  /** Map a raw webhook payload to a normalized event, or null if not actionable. */
  parseWebhookEvent(
    headers: Record<string, string | undefined>,
    payload: unknown,
  ): ForgeWebhookEvent | null;
  bustCache(): void;
}
