import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuotaChip } from './quota-chip';
import type { UsageSnapshotDto } from '@/lib/usage-api';
import { USAGE_PERCENT_MODE_KEY } from '@/lib/usage-percent-preference';

function snap(partial: Partial<UsageSnapshotDto> & Pick<UsageSnapshotDto, 'provider'>): UsageSnapshotDto {
  return {
    updatedAt: '2026-07-11T10:00:00.000Z',
    limits: [
      {
        window: 'Session',
        usedPercent: 3,
        resetsAt: '2026-07-11T14:00:00.000Z',
        windowDurationMins: 300,
      },
    ],
    usageLines: [],
    source: 'test',
    status: 'ok',
    planName: 'Max 20x',
    ...partial,
  };
}

describe('QuotaChip', () => {
  beforeEach(() => {
    window.localStorage.removeItem(USAGE_PERCENT_MODE_KEY);
  });

  it('renders the primary percent for the active provider', () => {
    render(
      <QuotaChip
        activeProvider="claude"
        snapshots={[
          snap({ provider: 'claude' }),
          snap({ provider: 'codex', limits: [{ window: 'Session', usedPercent: 50 }] }),
        ]}
      />,
    );
    expect(screen.getByTestId('quota-chip')).toHaveTextContent('3%');
  });

  it('hides when the active provider has no usable meters', () => {
    const { container } = render(
      <QuotaChip
        activeProvider="claude"
        snapshots={[snap({ provider: 'claude', status: 'needs-auth', limits: [], detail: 'Sign in' })]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('hides when activeProvider is not a usage provider', () => {
    const { container } = render(
      <QuotaChip activeProvider="pi" snapshots={[snap({ provider: 'claude' })]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('opens a panel with pinned active provider, mode toggle, and shared updated', async () => {
    const user = userEvent.setup();
    render(
      <QuotaChip
        activeProvider="codex"
        snapshots={[
          snap({ provider: 'claude', updatedAt: '2026-07-11T10:00:00.000Z' }),
          snap({ provider: 'codex', planName: 'Pro', updatedAt: '2026-07-11T10:05:00.000Z' }),
          snap({ provider: 'cursor', planName: 'Ultra', updatedAt: '2026-07-11T09:00:00.000Z' }),
        ]}
      />,
    );
    await user.click(screen.getByTestId('quota-chip'));
    expect(screen.getByTestId('quota-panel')).toBeInTheDocument();
    const cards = screen.getAllByTestId(/quota-card-/);
    expect(cards[0]).toHaveAttribute('data-testid', 'quota-card-codex');
    expect(screen.getByTestId('quota-percent-mode')).toBeInTheDocument();
    expect(screen.getByTestId('quota-updated')).toHaveTextContent(/Updated/);
    expect(screen.queryAllByText(/Updated/).length).toBe(1);

    await user.click(screen.getByRole('button', { name: 'left' }));
    expect(screen.getByTestId('quota-chip')).toHaveTextContent('97%');
  });
});
