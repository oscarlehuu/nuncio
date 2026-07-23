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
    payload: partial.payload === undefined ? { sessionId: 's1' } : partial.payload,
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

  it('renders Dismiss before Approve for an unapproved plan', () => {
    render(
      <ul>
        <AttentionRow
          item={makeItem({
            kind: 'dispatcher-proposal',
            title: 'Plan tomorrow',
            payload: {
              proposals: [
                {
                  subjectKey: 'checks:nuncio',
                  title: 'Fix checks',
                  prompt: 'Fix checks',
                  projectPath: '/Users/me/nuncio',
                  rationale: 'Checks are red',
                },
                {
                  subjectKey: 'pr:nuncio',
                  title: 'Review PR',
                  prompt: 'Review PR',
                  projectPath: '/Users/me/nuncio',
                  rationale: 'Review is waiting',
                },
              ],
            },
          })}
          onOpen={vi.fn()}
          onApprove={vi.fn()}
          onResolve={vi.fn()}
        />
      </ul>,
    );

    const dismiss = screen.getByRole('button', { name: /dismiss/i });
    const approve = screen.getByRole('button', { name: /approve 2 dispatcher proposals/i });
    expect(dismiss.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Approve queues 2 tasks to run tonight')).toBeInTheDocument();
  });

  it('renders Dismiss before Open for a PR review', () => {
    render(
      <ul>
        <AttentionRow
          item={makeItem({
            kind: 'pr-review',
            title: 'Review PR #42',
            payload: { projectPath: '/Users/me/nuncio', number: 42 },
          })}
          onOpen={vi.fn()}
          onApprove={vi.fn()}
          onResolve={vi.fn()}
        />
      </ul>,
    );

    const dismiss = screen.getByRole('button', { name: /dismiss/i });
    const open = screen.getByRole('button', { name: /open "review pr #42"/i });
    expect(dismiss.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers Create instead of Open for a spawn task with a session target', () => {
    render(
      <ul>
        <AttentionRow
          item={makeItem({
            kind: 'spawn-task',
            title: 'Add regression coverage',
            payload: { sessionId: 'source-session' },
          })}
          onOpen={vi.fn()}
          onApprove={vi.fn()}
          onResolve={vi.fn()}
          onCreate={vi.fn()}
        />
      </ul>,
    );

    expect(screen.queryByRole('button', { name: /open/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /create a session/i })).toBeInTheDocument();
  });

  it('offers only Dismiss for a missed schedule even when its payload has open targets', () => {
    const onOpen = vi.fn();
    render(
      <ul>
        <AttentionRow
          item={makeItem({
            kind: 'missed-schedule',
            title: 'Nightly run was missed',
            payload: { sessionId: 'session-that-must-not-open', url: 'https://example.com/run' },
          })}
          onOpen={onOpen}
          onApprove={vi.fn()}
          onResolve={vi.fn()}
        />
      </ul>,
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Dismiss "Nightly run was missed"' })).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
