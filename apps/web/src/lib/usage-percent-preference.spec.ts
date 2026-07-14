import { beforeEach, describe, expect, it } from 'vitest';
import {
  USAGE_PERCENT_MODE_KEY,
  loadUsagePercentMode,
  saveUsagePercentMode,
} from './usage-percent-preference';

describe('usage-percent-preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to used when nothing is stored', () => {
    expect(loadUsagePercentMode()).toBe('used');
  });

  it('round-trips left mode', () => {
    saveUsagePercentMode('left');
    expect(localStorage.getItem(USAGE_PERCENT_MODE_KEY)).toBe('left');
    expect(loadUsagePercentMode()).toBe('left');
  });

  it('treats corrupt values as used', () => {
    localStorage.setItem(USAGE_PERCENT_MODE_KEY, 'nope');
    expect(loadUsagePercentMode()).toBe('used');
  });
});
