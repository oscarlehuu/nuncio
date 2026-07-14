// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ChecksList,
  checkStatusClass,
  ForgeCommentCard,
  ForgeStateBadge,
  forgeTimeAgo,
} from './forge-ui';

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    relativeTime: vi.fn(() => '2h ago'),
  };
});

describe('forge-ui helpers', () => {
  it('forgeTimeAgo delegates to relativeTime for valid ISO timestamps', () => {
    const iso = '2026-01-01T12:00:00.000Z';
    expect(forgeTimeAgo(iso)).toBe('2h ago');
  });

  it('forgeTimeAgo returns empty string for invalid timestamps', () => {
    expect(forgeTimeAgo('not-a-date')).toBe('');
  });

  it('checkStatusClass maps conclusions to semantic classes', () => {
    expect(checkStatusClass('success')).toContain('text-success');
    expect(checkStatusClass('failure')).toContain('text-destructive');
    expect(checkStatusClass('skipped')).toContain('text-muted-foreground');
    expect(checkStatusClass(null)).toContain('text-warning');
  });
});

describe('ForgeStateBadge', () => {
  it('renders open/merged/closed states', () => {
    const { rerender } = render(<ForgeStateBadge state="open" />);
    expect(screen.getByText('open')).toBeInTheDocument();

    rerender(<ForgeStateBadge state="merged" />);
    expect(screen.getByText('merged')).toBeInTheDocument();

    rerender(<ForgeStateBadge state="closed" />);
    expect(screen.getByText('closed')).toBeInTheDocument();
  });

  it('shows draft label for open drafts', () => {
    render(<ForgeStateBadge state="open" draft />);
    expect(screen.getByText('draft')).toBeInTheDocument();
  });

  it('falls back for unknown states', () => {
    render(<ForgeStateBadge state="unknown-state" />);
    expect(screen.getByText('unknown-state')).toBeInTheDocument();
  });
});

describe('ChecksList', () => {
  it('shows empty state when there are no checks', () => {
    render(<ChecksList checks={[]} />);
    expect(screen.getByText('No checks reported.')).toBeInTheDocument();
  });

  it('renders check rows with conclusion or status fallback', () => {
    render(
      <ChecksList
        checks={[
          { name: 'ci/test', status: 'completed', conclusion: 'success' },
          { name: 'ci/lint', status: 'in_progress', conclusion: null },
        ]}
      />,
    );
    expect(screen.getByText('ci/test')).toBeInTheDocument();
    expect(screen.getByText('success')).toBeInTheDocument();
    expect(screen.getByText('in_progress')).toBeInTheDocument();
  });
});

describe('ForgeCommentCard', () => {
  it('renders author, relative time, and markdown body', () => {
    render(
      <ForgeCommentCard
        comment={{
          id: '1',
          author: 'octo',
          body: 'Looks **good** to me',
          createdAt: '2026-01-01T00:00:00Z',
        }}
      />,
    );
    expect(screen.getByText('octo')).toBeInTheDocument();
    expect(screen.getByText('2h ago')).toBeInTheDocument();
    expect(screen.getByText('good')).toBeInTheDocument();
  });
});
