import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, fetchDigest: vi.fn() };
});

import { HomeDigestLine } from './home-digest-line';
import { fetchDigest, type DigestRunDto } from '../lib/api';
import { digestNarrative } from '../lib/home-digest-narrative';

function dto(
  variant: 'morning' | 'evening',
  partial: Partial<Pick<DigestRunDto['digest'], 'loops' | 'attention' | 'sessions'>> = {},
): DigestRunDto {
  return {
    slotKey: `2026-07-23:${variant}`,
    variant,
    sentAt: 1,
    windowFrom: 0,
    windowTo: 1,
    digest: {
      variant,
      windowFrom: 0,
      windowTo: 1,
      loops: partial.loops ?? { runsOk: 0, runsFailed: 0, prsOpened: 0 },
      attention: partial.attention ?? { raised: 0, resolved: 0, openTopCount: 0 },
      sessions: partial.sessions ?? { completed: 0, needsYou: 0 },
      budget: { runsToday: 0, cap: 24 },
      highlights: [],
      projectLines: [],
    },
  };
}

describe('HomeDigestLine', () => {
  beforeEach(() => {
    vi.mocked(fetchDigest).mockReset();
  });

  it('summarizes an evening window with singular grammar', () => {
    expect(digestNarrative(dto('evening', {
      loops: { runsOk: 1, runsFailed: 0, prsOpened: 1 },
      attention: { raised: 0, resolved: 0, openTopCount: 1 },
      sessions: { completed: 1, needsYou: 0 },
    }))).toBe('Today: 1 run, 1 green, 1 PR opened — 1 thing needs you.');
  });

  it('uses the quiet-window sentence when every narrative count is zero', () => {
    expect(digestNarrative(dto('morning'))).toBe('Quiet night — nothing ran, nothing needs you.');
  });

  it('does not call the night quiet when sessions completed', () => {
    expect(digestNarrative(dto('morning', {
      sessions: { completed: 2, needsYou: 0 },
    }))).toBe('Overnight: 0 runs, 0 green, 0 PRs opened — 0 things need you.');
  });

  it('renders nothing when no digest exists', async () => {
    vi.mocked(fetchDigest).mockResolvedValue(null);
    const { container } = render(<HomeDigestLine />);
    await waitFor(() => expect(fetchDigest).toHaveBeenCalledWith('latest'));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the digest cannot load', async () => {
    vi.mocked(fetchDigest).mockRejectedValue(new Error('offline'));
    const { container } = render(<HomeDigestLine />);
    await waitFor(() => expect(fetchDigest).toHaveBeenCalledWith('latest'));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/digest/i)).not.toBeInTheDocument();
  });
});
