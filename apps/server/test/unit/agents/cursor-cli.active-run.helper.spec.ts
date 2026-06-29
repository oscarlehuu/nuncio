import { describe, it, expect } from 'bun:test';
import { isCursorCliRecentlyActive, ACTIVE_RUN_MS } from '../../../src/agents/providers/cursor-cli.active-run';

describe('isCursorCliRecentlyActive', () => {
  const now = 1_000_000;

  it('returns false when both mtimes are null', () => {
    expect(isCursorCliRecentlyActive(null, null, false, now)).toBe(false);
  });

  it('returns true when transcript mtime is within ACTIVE_RUN_MS', () => {
    expect(isCursorCliRecentlyActive(now - 1000, null, false, now)).toBe(true);
  });

  it('returns false when transcript mtime is older than ACTIVE_RUN_MS', () => {
    expect(isCursorCliRecentlyActive(now - ACTIVE_RUN_MS - 1, null, false, now)).toBe(false);
  });

  it('returns true when store mtime is recent even if transcript is stale', () => {
    expect(isCursorCliRecentlyActive(now - ACTIVE_RUN_MS - 1, now - 500, false, now)).toBe(true);
  });

  it('returns false when turnEnded is true even if mtime is recent', () => {
    expect(isCursorCliRecentlyActive(now - 1000, now - 500, true, now)).toBe(false);
  });
});
