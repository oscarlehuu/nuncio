export const USAGE_PERCENT_MODE_KEY = 'nuncio-usage-percent-mode';

export type UsagePercentMode = 'used' | 'left';

export function loadUsagePercentMode(): UsagePercentMode {
  if (typeof window === 'undefined') return 'used';
  try {
    const raw = window.localStorage.getItem(USAGE_PERCENT_MODE_KEY);
    return raw === 'left' ? 'left' : 'used';
  } catch {
    return 'used';
  }
}

export function saveUsagePercentMode(mode: UsagePercentMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(USAGE_PERCENT_MODE_KEY, mode);
  } catch {
    // ignore quota / private mode
  }
}
