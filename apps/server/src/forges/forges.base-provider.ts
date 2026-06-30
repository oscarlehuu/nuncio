import { HttpException } from '@nestjs/common';
import type {
  CreatePullRequestOptions,
  ForgeAuth,
  ForgeCheck,
  ForgeProvider,
  ForgePullRequest,
  ForgeRepoRef,
  ForgeUser,
  ForgeWebhookEvent,
} from './forges.types';

export abstract class BaseForgeProvider implements ForgeProvider {
  abstract readonly id: string;
  abstract readonly name: string;

  /** Test hook: inject a stub fetch implementation instead of global fetch. */
  fetchOverride?: typeof fetch;
  /** Test hook: inject a CLI token resolver without shelling out to gh/glab. */
  cliTokenOverride?: () => Promise<string | null>;

  abstract isAvailable(): Promise<boolean>;
  abstract resolveAuth(): Promise<ForgeAuth | null>;
  abstract getCurrentUser(): Promise<ForgeUser>;
  abstract createPullRequest(
    repo: ForgeRepoRef,
    opts: CreatePullRequestOptions,
  ): Promise<ForgePullRequest>;
  abstract getPullRequest(repo: ForgeRepoRef, number: number): Promise<ForgePullRequest>;
  abstract listChecks(repo: ForgeRepoRef, ref: string): Promise<ForgeCheck[]>;
  abstract addComment(repo: ForgeRepoRef, number: number, body: string): Promise<void>;
  abstract verifyWebhookSignature(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): boolean;
  abstract parseWebhookEvent(
    headers: Record<string, string | undefined>,
    payload: unknown,
  ): ForgeWebhookEvent | null;
  abstract bustCache(): void;

  protected async request<T>(url: string, init?: RequestInit): Promise<T> {
    const fetchImpl = this.fetchOverride ?? fetch;
    const response = await fetchImpl(url, init);
    const body = await this.parseJson(response);

    if (!response.ok) {
      const message = this.errorMessage(response, body);
      throw new HttpException(message, response.status);
    }

    return body as T;
  }

  private async parseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private errorMessage(response: Response, body: unknown): string {
    const forgeMessage =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : response.statusText || 'request failed';
    return `${this.name} request failed (${response.status}): ${forgeMessage}`;
  }
}
