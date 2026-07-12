import { claudeUsageFetcher } from './fetchers/claude.fetcher';
import { codexUsageFetcher } from './fetchers/codex.fetcher';
import { cursorUsageFetcher } from './fetchers/cursor.fetcher';
import type { ProviderUsageFetcher, UsageProviderId } from './usage.types';

export const USAGE_FETCHERS: Record<UsageProviderId, ProviderUsageFetcher> = {
  claude: claudeUsageFetcher,
  codex: codexUsageFetcher,
  cursor: cursorUsageFetcher,
};
