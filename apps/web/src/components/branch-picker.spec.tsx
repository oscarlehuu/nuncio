import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { BranchPicker } from './branch-picker';

const mockFetchBranches = vi.fn();

vi.mock('../lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/projects')>();
  return {
    ...actual,
    fetchBranches: (...args: unknown[]) => mockFetchBranches(...args),
  };
});

describe('BranchPicker', () => {
  beforeEach(() => {
    mockFetchBranches.mockResolvedValue([
      { name: 'main', isDefault: true, isCurrent: true },
      { name: 'develop', isDefault: false, isCurrent: false },
    ]);
  });

  it('is disabled until a project path is provided', () => {
    render(<BranchPicker onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /branch/i })).toBeDisabled();
  });

  it('loads branches when projectPath is set and selects one', async () => {
    function ControlledPicker() {
      const [branch, setBranch] = useState<string | undefined>();
      return (
        <BranchPicker projectPath="/code/nuncio" value={branch} onChange={setBranch} />
      );
    }

    render(<ControlledPicker />);

    await waitFor(() => {
      expect(mockFetchBranches).toHaveBeenCalledWith('/code/nuncio');
    });

    await waitFor(async () => {
      expect(await screen.findByRole('button', { name: /main/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /main/i }));
    await userEvent.click(await screen.findByRole('option', { name: /^develop$/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /develop/i })).toBeInTheDocument();
    });
  });

  it('prefers the current branch over the default branch', async () => {
    mockFetchBranches.mockResolvedValue([
      { name: 'main', isDefault: true, isCurrent: false },
      { name: 'feature/local-work', isDefault: false, isCurrent: true },
    ]);

    function ControlledPicker() {
      const [branch, setBranch] = useState<string | undefined>();
      return (
        <BranchPicker projectPath="/code/nuncio" value={branch} onChange={setBranch} />
      );
    }

    render(<ControlledPicker />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /feature\/local-work/i })).toBeInTheDocument();
    });
  });

  it('hides generated Nuncio session branches and resets stale selections', async () => {
    mockFetchBranches.mockResolvedValue([
      { name: 'main', isDefault: true, isCurrent: false },
      { name: 'nuncio/028ea01c-what-is-your-model', isDefault: false, isCurrent: true },
      { name: 'develop', isDefault: false, isCurrent: false },
    ]);

    function ControlledPicker() {
      const [branch, setBranch] = useState<string | undefined>(
        'nuncio/028ea01c-what-is-your-model',
      );
      return (
        <BranchPicker projectPath="/code/nuncio" value={branch} onChange={setBranch} />
      );
    }

    render(<ControlledPicker />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /main/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /main/i }));
    expect(
      screen.queryByRole('option', { name: /nuncio\/028ea01c-what-is-your-model/i }),
    ).toBeNull();
    expect(screen.getByRole('option', { name: /^develop$/i })).toBeInTheDocument();
  });
});
