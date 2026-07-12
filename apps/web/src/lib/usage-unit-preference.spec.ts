import { describe, expect, it, beforeEach } from 'vitest';
import { loadUsageUnit, saveUsageUnit, USAGE_UNIT_KEY } from './usage-unit-preference';

describe('usage-unit-preference', () => {
  beforeEach(() => {
    window.localStorage.removeItem(USAGE_UNIT_KEY);
  });

  it('defaults to tokens and persists usd', () => {
    expect(loadUsageUnit()).toBe('tokens');
    saveUsageUnit('usd');
    expect(loadUsageUnit()).toBe('usd');
    saveUsageUnit('tokens');
    expect(loadUsageUnit()).toBe('tokens');
  });
});
