import { describe, expect, it } from 'vitest';
import { relativeTimeLabel } from './mobile-ui';

describe('relativeTimeLabel', () => {
  const now = Date.UTC(2026, 0, 2, 12);

  it.each([
    [5_000, 'just now'],
    [5 * 60_000, '5m ago'],
    [3 * 3_600_000, '3h ago'],
    [2 * 86_400_000, '2d ago'],
  ])('formats %s milliseconds ago', (elapsed, expected) => {
    expect(relativeTimeLabel(now - elapsed, now)).toBe(expected);
  });

  it('formats future timestamps as just now', () => {
    expect(relativeTimeLabel(now + 60_000, now)).toBe('just now');
  });
});
