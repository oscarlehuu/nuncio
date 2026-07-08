import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, fetchDigest: vi.fn() };
});

import { DigestCard } from './digest-card';
import { fetchDigest, type DigestRunDto } from '../lib/api';

function dto(variant: 'morning' | 'evening'): DigestRunDto {
  return {
    slotKey: `2026-07-07:${variant}`,
    variant,
    sentAt: Date.now() - 3_600_000,
    windowFrom: 0,
    windowTo: 1,
    digest: {
      variant,
      windowFrom: 0,
      windowTo: 1,
      loops: { runsOk: 0, runsFailed: 0, prsOpened: 0 },
      attention: { raised: 0, resolved: 0, openTopCount: 0 },
      sessions: { completed: 0, needsYou: 0 },
      budget: { runsToday: 0, cap: 24 },
      highlights: [],
      projectLines: [],
    },
  };
}

describe('DigestCard', () => {
  beforeEach(() => {
    vi.mocked(fetchDigest).mockReset();
  });

  it('renders a link to the digest when one exists', async () => {
    vi.mocked(fetchDigest).mockResolvedValue(dto('morning'));
    const onOpen = vi.fn();
    render(<DigestCard onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText("Today's digest")).toBeInTheDocument());
    expect(screen.getByText(/Morning digest/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /read the morning digest/i }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('renders nothing until a digest exists', async () => {
    vi.mocked(fetchDigest).mockResolvedValue(null);
    const { container } = render(<DigestCard onOpen={vi.fn()} />);
    await waitFor(() => expect(fetchDigest).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('renders nothing when the digest fetch fails', async () => {
    vi.mocked(fetchDigest).mockRejectedValue(new Error('offline'));
    const { container } = render(<DigestCard onOpen={vi.fn()} />);
    await waitFor(() => expect(fetchDigest).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
