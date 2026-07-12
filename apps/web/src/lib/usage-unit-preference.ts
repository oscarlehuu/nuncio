export const USAGE_UNIT_KEY = 'nuncio-usage-unit';

export type UsageUnit = 'tokens' | 'usd';

/** Blended $/MTok — must match server `USD_PER_MTOK`. */
export const USAGE_USD_PER_MTOK: Record<'claude' | 'codex' | 'cursor', number> = {
  claude: 5,
  codex: 5,
  cursor: 10,
};

export function loadUsageUnit(): UsageUnit {
  if (typeof window === 'undefined') return 'tokens';
  try {
    const raw = window.localStorage.getItem(USAGE_UNIT_KEY);
    return raw === 'usd' ? 'usd' : 'tokens';
  } catch {
    return 'tokens';
  }
}

export function saveUsageUnit(unit: UsageUnit): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(USAGE_UNIT_KEY, unit);
  } catch {
    // ignore quota / private mode
  }
}

export function formatUsageTotal(
  tokens: number,
  provider: 'claude' | 'codex' | 'cursor',
  unit: UsageUnit,
): string {
  if (unit === 'usd') {
    const usd = (tokens / 1_000_000) * USAGE_USD_PER_MTOK[provider];
    if (usd < 0.01 && usd > 0) return `~$${usd.toFixed(3)}`;
    return `~$${usd.toFixed(2)}`;
  }
  if (tokens < 1_000) return `${tokens} tokens`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}K tokens`;
  return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
}
