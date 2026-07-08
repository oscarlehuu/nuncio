import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FleetRow } from './fleet-row';
import type { FleetRow as FleetRowDto } from '../lib/api';

function row(partial: Partial<FleetRowDto>): FleetRowDto {
  return {
    path: '/p',
    name: partial.name ?? 'proj',
    weight: partial.weight ?? 1,
    health: partial.health ?? 'green',
    reasons: partial.reasons ?? [],
    topItem: partial.topItem ?? null,
    counts: {
      openAttention: 0,
      runningSessions: 0,
      activeLoops: 0,
      openPRs: 0,
      ...partial.counts,
    },
    lastActivityAt: partial.lastActivityAt ?? null,
  };
}

describe('FleetRow', () => {
  it('a green row with nothing open reads "All clear"', () => {
    render(<ul><FleetRow row={row({ health: 'green' })} onOpen={vi.fn()} /></ul>);
    expect(screen.getByText('All clear')).toBeInTheDocument();
  });

  it('falls back to the reasons line when there is no top item', () => {
    render(<ul><FleetRow row={row({ health: 'yellow', reasons: ['2 PRs awaiting review'] })} onOpen={vi.fn()} /></ul>);
    expect(screen.getByText('2 PRs awaiting review')).toBeInTheDocument();
  });

  it('shows the weight badge only when weight > 1', () => {
    const { rerender } = render(<ul><FleetRow row={row({ weight: 1 })} onOpen={vi.fn()} /></ul>);
    expect(screen.queryByText(/^×/)).not.toBeInTheDocument();
    rerender(<ul><FleetRow row={row({ weight: 3 })} onOpen={vi.fn()} /></ul>);
    expect(screen.getByText('×3')).toBeInTheDocument();
  });

  it('renders quiet counts only for non-zero stats', () => {
    render(
      <ul>
        <FleetRow
          row={row({ counts: { openAttention: 0, runningSessions: 2, activeLoops: 1, openPRs: 0 } })}
          onOpen={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('loops')).toBeInTheDocument();
    expect(screen.queryByText('PRs')).not.toBeInTheDocument();
  });

  it('does not surface the top-item Open action on a non-red row', () => {
    const topItem = {
      id: 'i', kind: 'pr-review', subjectId: 's', projectPath: null, severity: 2,
      title: 'Review PR', payload: { url: 'https://x' }, status: 'open' as const,
      acknowledgedAt: null, createdAt: 0, updatedAt: 0, resolvedAt: null,
    };
    render(<ul><FleetRow row={row({ health: 'yellow', topItem })} onOpen={vi.fn()} onOpenTopItem={vi.fn()} /></ul>);
    expect(screen.queryByRole('button', { name: /Open Review PR/ })).not.toBeInTheDocument();
  });
});
