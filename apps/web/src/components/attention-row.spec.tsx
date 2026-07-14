import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttentionRow } from './attention-row';
import type { AttentionItemDto } from '../lib/api';

function makeItem(partial: Partial<AttentionItemDto> = {}): AttentionItemDto {
  return {
    id: partial.id ?? 'i1',
    kind: partial.kind ?? 'permission',
    subjectId: partial.subjectId ?? 's1',
    projectPath: partial.projectPath ?? '/Users/me/nuncio',
    severity: partial.severity ?? 5,
    title: partial.title ?? 'Agent needs approval',
    payload: partial.payload ?? { sessionId: 's1' },
    status: 'open',
    acknowledgedAt: partial.acknowledgedAt ?? null,
    createdAt: partial.createdAt ?? Date.now() - 60_000,
    updatedAt: 0,
    resolvedAt: null,
  };
}

describe('AttentionRow', () => {
  it('shows kind chip, title, and Open/Dismiss for a permission item', async () => {
    const onOpen = vi.fn();
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(
      <ul>
        <AttentionRow
          item={makeItem()}
          onOpen={onOpen}
          onApprove={vi.fn()}
          onAck={vi.fn()}
          onResolve={onResolve}
        />
      </ul>,
    );

    expect(screen.getByText('Permission')).toBeInTheDocument();
    expect(screen.getByText('Agent needs approval')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open "Agent needs approval"' }));
    expect(onOpen).toHaveBeenCalledWith({ to: '/session/s1' });

    await user.click(screen.getByRole('button', { name: 'Dismiss "Agent needs approval"' }));
    expect(onResolve).toHaveBeenCalledWith('i1');
  });

  it('shows Mark seen for crew items instead of Dismiss', async () => {
    const onAck = vi.fn();
    const user = userEvent.setup();
    render(
      <ul>
        <AttentionRow
          item={makeItem({ kind: 'crew-blocked', title: 'Crew is blocked', payload: { taskId: 't1' } })}
          onOpen={vi.fn()}
          onApprove={vi.fn()}
          onAck={onAck}
          onResolve={vi.fn()}
        />
      </ul>,
    );

    expect(screen.getByText('Crew blocked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark "Crew is blocked" seen' }));
    expect(onAck).toHaveBeenCalledWith('i1');
  });
});
