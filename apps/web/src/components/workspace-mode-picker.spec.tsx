import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceModePicker } from './workspace-mode-picker';

describe('WorkspaceModePicker', () => {
  it('shows work locally by default and reports new worktree selection', async () => {
    const onChange = vi.fn();
    render(<WorkspaceModePicker value="local" onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: /work locally/i }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /new worktree/i }));

    expect(onChange).toHaveBeenCalledWith('worktree');
  });

  it('can be disabled until a project is selected', () => {
    render(<WorkspaceModePicker value="local" onChange={vi.fn()} disabled />);

    expect(screen.getByRole('button', { name: /work locally/i })).toBeDisabled();
  });
});
