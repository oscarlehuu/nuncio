import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsageHistoryChart } from './usage-history-chart';
import { formatUsageTotal } from '@/lib/usage-unit-preference';

const DAYS = [
  { date: '2026-07-10', claude: 1000, codex: 500, cursor: 0 },
  { date: '2026-07-11', claude: 0, codex: 200, cursor: 100 },
];

describe('UsageHistoryChart', () => {
  it('renders stacked bars and idle provider totals in the readout', () => {
    render(<UsageHistoryChart unit="tokens" days={DAYS} />);
    expect(screen.getByTestId('usage-history-chart')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Local token usage/i })).toBeInTheDocument();
    const readout = screen.getByTestId('usage-history-readout');
    expect(readout).toHaveTextContent('Claude');
    expect(readout).toHaveTextContent(/1\.0K|1K/); // 1000 period total for claude
    expect(screen.getByTestId('usage-legend-claude')).toBeInTheDocument();
    expect(screen.queryByText(/Hover a day/i)).not.toBeInTheDocument();
  });

  it('places the peak label outside the SVG so bars cannot cover it', () => {
    render(
      <UsageHistoryChart
        unit="tokens"
        days={[{ date: '2026-07-11', claude: 395_800_000, codex: 0, cursor: 0 }]}
      />,
    );
    const maxLabel = screen.getByTestId('usage-history-max');
    expect(maxLabel).toHaveTextContent('395.8M');
    expect(maxLabel.closest('svg')).toBeNull();
  });

  it('swaps readout values to the hovered day', async () => {
    const user = userEvent.setup();
    render(<UsageHistoryChart unit="tokens" days={DAYS} />);
    await user.hover(screen.getByTestId('usage-history-bar-2026-07-10'));
    const readout = screen.getByTestId('usage-history-readout');
    expect(readout).toHaveTextContent('2026-07-10');
    expect(readout).toHaveTextContent('Claude');
    expect(readout).toHaveTextContent(/1\.0K|1K/);
    expect(readout).toHaveTextContent('Codex');
    expect(readout.closest('svg')).toBeNull();
  });

  it('filters to one provider on legend click and clears on second click', async () => {
    const user = userEvent.setup();
    render(<UsageHistoryChart unit="tokens" days={DAYS} />);

    await user.click(screen.getByTestId('usage-legend-claude'));
    expect(screen.getByTestId('usage-legend-claude')).toHaveAttribute('aria-pressed', 'true');

    await user.hover(screen.getByTestId('usage-history-bar-2026-07-10'));
    // Filtered providers stay visible (dimmed) so the filter can be cleared.
    expect(screen.getByTestId('usage-legend-codex')).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByTestId('usage-legend-claude'));
    expect(screen.getByTestId('usage-legend-claude')).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows empty filter state when the selected provider has no tokens', async () => {
    const user = userEvent.setup();
    render(
      <UsageHistoryChart
        unit="tokens"
        days={[
          { date: '2026-07-10', claude: 100, codex: 0, cursor: 0 },
          { date: '2026-07-11', claude: 50, codex: 0, cursor: 0 },
        ]}
      />,
    );
    await user.click(screen.getByTestId('usage-legend-cursor'));
    expect(screen.getByTestId('usage-history-filter-empty')).toHaveTextContent(/Cursor/);
  });

  it('shows empty state when all zeros', () => {
    render(
      <UsageHistoryChart
        unit="tokens"
        days={[
          { date: '2026-07-10', claude: 0, codex: 0, cursor: 0 },
          { date: '2026-07-11', claude: 0, codex: 0, cursor: 0 },
        ]}
      />,
    );
    expect(screen.getByText(/No local token activity/i)).toBeInTheDocument();
  });

  it('formats totals for tokens and usd', () => {
    expect(formatUsageTotal(1500, 'claude', 'tokens')).toMatch(/1\.5K|1500/);
    expect(formatUsageTotal(1_000_000, 'claude', 'usd')).toMatch(/\$5/);
  });
});
