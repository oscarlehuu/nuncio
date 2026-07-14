// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../lib/forge-api', () => ({ createForgeIssue: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NewIssueDialog } from './new-issue-dialog';
import { createForgeIssue } from '../../lib/forge-api';

const REPO = '/Users/me/nuncio';

describe('NewIssueDialog', () => {
  beforeEach(() => {
    vi.mocked(createForgeIssue).mockReset();
  });

  it('keeps Create disabled until title is non-empty', () => {
    render(
      <NewIssueDialog path={REPO} open onOpenChange={vi.fn()} onCreated={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /create issue/i })).toBeDisabled();
  });

  it('creates an issue, toasts success, and notifies parent', async () => {
    vi.mocked(createForgeIssue).mockResolvedValue({
      number: 55,
      title: 'New bug',
      state: 'open',
      author: 'octo',
      labels: [],
      assignees: [],
      commentCount: 0,
      updatedAt: '2026-01-01T00:00:00Z',
      url: 'https://github.com/octo/nuncio/issues/55',
    });
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();
    const user = userEvent.setup();

    render(
      <NewIssueDialog path={REPO} open onOpenChange={onOpenChange} onCreated={onCreated} />,
    );

    await user.type(screen.getByPlaceholderText('Title'), 'New bug');
    await user.type(screen.getByPlaceholderText('Description (markdown)'), 'Details here');
    await user.click(screen.getByRole('button', { name: /create issue/i }));

    await waitFor(() =>
      expect(createForgeIssue).toHaveBeenCalledWith(REPO, {
        title: 'New bug',
        body: 'Details here',
      }),
    );
    const { toast } = await import('sonner');
    expect(toast.success).toHaveBeenCalledWith('Issue #55 created');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreated).toHaveBeenCalledWith(55);
  });

  it('toasts API failures', async () => {
    vi.mocked(createForgeIssue).mockRejectedValue(new Error('Forge rejected'));
    const user = userEvent.setup();
    render(
      <NewIssueDialog path={REPO} open onOpenChange={vi.fn()} onCreated={vi.fn()} />,
    );

    await user.type(screen.getByPlaceholderText('Title'), 'Broken flow');
    await user.click(screen.getByRole('button', { name: /create issue/i }));

    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Forge rejected'));
  });

  it('closes via Cancel without creating', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <NewIssueDialog path={REPO} open onOpenChange={onOpenChange} onCreated={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(createForgeIssue).not.toHaveBeenCalled();
  });
});
