import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsageSettingsSection } from './usage-settings-section';
import { resetUsageCacheForTests } from '@/lib/usage-cache';

vi.mock('@/lib/usage-api', () => ({
  fetchProviderUsage: vi.fn(async () => [
    {
      provider: 'claude',
      updatedAt: '2026-07-11T10:00:00.000Z',
      limits: [{ window: 'Session', usedPercent: 3, resetsAt: '2026-07-11T14:00:00.000Z' }],
      usageLines: [],
      source: 'test',
      status: 'ok',
      planName: 'Max 20x',
    },
    {
      provider: 'codex',
      updatedAt: '2026-07-11T10:00:00.000Z',
      limits: [],
      usageLines: [],
      source: 'test',
      status: 'needs-auth',
      detail: 'Sign in with `codex login` to see usage.',
    },
    {
      provider: 'cursor',
      updatedAt: '2026-07-11T10:00:00.000Z',
      limits: [{ window: 'Total', usedPercent: 17 }],
      usageLines: [{ label: 'Credits', value: '$500.00' }],
      source: 'test',
      status: 'ok',
      planName: 'Ultra',
    },
  ]),
  fetchUsageHistory: vi.fn(async () => ({
    days: [
      { date: '2026-07-10', claude: 1000, codex: 0, cursor: 0 },
      { date: '2026-07-11', claude: 500, codex: 200, cursor: 0 },
    ],
    totals: { claude: 1500, codex: 200, cursor: 0 },
    estimatedUsdTotals: { claude: 0.0075, codex: 0.001, cursor: 0 },
    updatedAt: '2026-07-11T10:00:00.000Z',
  })),
}));

describe('UsageSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUsageCacheForTests();
  });

  it('renders provider rows, analytics chart, and unit toggle', async () => {
    render(<UsageSettingsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('usage-settings-row-claude')).toBeInTheDocument();
    });
    expect(screen.getByTestId('usage-settings-row-codex')).toBeInTheDocument();
    expect(screen.getByTestId('usage-settings-row-cursor')).toBeInTheDocument();
    expect(screen.getByTestId('usage-settings-row-codex')).toHaveTextContent('codex login');
    expect(screen.getByTestId('usage-settings-row-codex')).toHaveTextContent('Not signed in');
    expect(screen.getByTestId('usage-settings-updated')).toHaveTextContent(/Updated/);
    expect(screen.getByTestId('usage-settings-percent-mode')).toBeInTheDocument();
    expect(screen.getByTestId('usage-settings-unit-mode')).toBeInTheDocument();
    expect(screen.getByTestId('usage-heatmap')).toBeInTheDocument();
    expect(screen.getByTestId('usage-analytics-panel')).toHaveTextContent(/Last 90 days|Last 30 days/);
    expect(screen.getByTestId('usage-activity-view')).toBeInTheDocument();
  });

  it('expands needs-auth row with CLI CTA', async () => {
    const user = userEvent.setup();
    render(<UsageSettingsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('usage-settings-row-codex')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('usage-settings-row-codex').querySelector('button')!);
    expect(screen.getByTestId('usage-auth-cta-codex')).toHaveTextContent('codex login');
  });
});
