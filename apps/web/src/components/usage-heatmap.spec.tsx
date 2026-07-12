import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsageHeatmap } from './usage-heatmap';
import { buildHeatmapWeeks, heatmapLevel } from '@/lib/usage-heatmap-utils';

describe('heatmap helpers', () => {
  it('builds Monday-first weeks with null pads', () => {
    // 2026-07-10 is a Friday → week starts Mon 07-06
    const weeks = buildHeatmapWeeks([
      { date: '2026-07-10', claude: 100, codex: 0, cursor: 0 },
      { date: '2026-07-11', claude: 50, codex: 20, cursor: 0 },
    ]);
    expect(weeks.length).toBeGreaterThanOrEqual(1);
    const firstWeek = weeks[0]!;
    expect(firstWeek).toHaveLength(7);
    expect(firstWeek.filter(Boolean).length).toBeGreaterThan(0);
    expect(firstWeek.some((cell) => cell?.date === '2026-07-10')).toBe(true);
  });

  it('maps values into intensity levels', () => {
    expect(heatmapLevel(0, 100)).toBe(0);
    expect(heatmapLevel(10, 100)).toBe(1);
    expect(heatmapLevel(40, 100)).toBe(3);
    expect(heatmapLevel(100, 100)).toBe(4);
  });
});

describe('UsageHeatmap', () => {
  const days = [
    { date: '2026-07-08', claude: 0, codex: 0, cursor: 0 },
    { date: '2026-07-09', claude: 200, codex: 0, cursor: 0 },
    { date: '2026-07-10', claude: 1000, codex: 500, cursor: 0 },
    { date: '2026-07-11', claude: 0, codex: 200, cursor: 100 },
  ];

  it('renders a full-width grid with cells and idle provider totals', () => {
    render(<UsageHeatmap unit="tokens" days={days} />);
    expect(screen.getByTestId('usage-heatmap')).toBeInTheDocument();
    const grid = screen.getByTestId('usage-heatmap-grid');
    expect(grid).toBeInTheDocument();
    expect(grid.className).toMatch(/\bw-full\b/);
    expect(screen.getByTestId('usage-heatmap-cell-2026-07-10')).toHaveAttribute('data-level', '4');
    expect(screen.getByTestId('usage-heatmap-readout')).toHaveTextContent('Claude');
  });

  it('updates readout on cell hover and filters via legend', async () => {
    const user = userEvent.setup();
    render(<UsageHeatmap unit="tokens" days={days} />);
    await user.hover(screen.getByTestId('usage-heatmap-cell-2026-07-10'));
    expect(screen.getByTestId('usage-heatmap-readout')).toHaveTextContent('2026-07-10');
    expect(screen.getByTestId('usage-heatmap-readout')).toHaveTextContent('Codex');

    await user.click(screen.getByTestId('usage-heatmap-legend-claude'));
    expect(screen.getByTestId('usage-heatmap-legend-claude')).toHaveAttribute('aria-pressed', 'true');
  });
});
