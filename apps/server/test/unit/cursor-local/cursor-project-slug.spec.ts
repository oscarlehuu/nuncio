import { describe, expect, it } from 'bun:test';
import { toProjectSlug } from '../../../src/cursor-local/cursor-project-slug';

describe('toProjectSlug', () => {
  it('maps a normal workspace path to Cursor project slug', () => {
    expect(toProjectSlug('/Users/me/Desktop/Oscar/nuncio')).toBe(
      'Users-me-Desktop-Oscar-nuncio',
    );
  });

  it('strips leading dots from hidden path segments like .cursor', () => {
    expect(toProjectSlug('/Users/a1241968/.cursor/worktrees/nuncio/fd0m')).toBe(
      'Users-a1241968-cursor-worktrees-nuncio-fd0m',
    );
  });
});
