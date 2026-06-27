import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectPicker } from './project-picker';

const mockFetchProjects = vi.fn();
const mockFolderBrowserSelect = vi.fn();

vi.mock('../lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/projects')>();
  return {
    ...actual,
    fetchProjects: (...args: unknown[]) => mockFetchProjects(...args),
  };
});

// Mock the folder browser so the picker spec does not exercise the real
// fetchDirectories network call. Capture onSelect so we can simulate a
// selection and verify the picker forwards the path to onChange.
vi.mock('./folder-browser', () => ({
  FolderBrowser: ({ open, onSelect, onCancel }: {
    open: boolean;
    onSelect: (path: string) => void;
    onCancel: () => void;
  }) => {
    mockFolderBrowserSelect.mockImplementation((path: string) => onSelect(path));
    return open ? (
      <div data-testid="folder-browser-mock">
        <button onClick={() => onSelect('/Users/dev/picked-repo')}>mock-pick</button>
        <button onClick={onCancel}>mock-cancel</button>
      </div>
    ) : null;
  },
}));

describe('ProjectPicker', () => {
  beforeEach(() => {
    mockFetchProjects.mockReset();
    mockFolderBrowserSelect.mockReset();
    mockFetchProjects.mockResolvedValue([
      { id: '/code/nuncio', name: 'nuncio', path: '/code/nuncio', isGit: true },
    ]);
  });

  it('lists projects and selects one', async () => {
    const onChange = vi.fn();
    render(<ProjectPicker onChange={onChange} />);

    await userEvent.click(await screen.findByRole('button', { name: /no repo/i }));
    await userEvent.click(await screen.findByRole('option', { name: /nuncio/i }));

    expect(onChange).toHaveBeenCalledWith('/code/nuncio');
  });

  it('supports entering a custom path', async () => {
    const onChange = vi.fn();
    render(<ProjectPicker onChange={onChange} />);

    await userEvent.click(await screen.findByRole('button', { name: /no repo/i }));
    await userEvent.click(await screen.findByRole('option', { name: /custom path/i }));

    const input = await screen.findByLabelText(/custom project path/i);
    await userEvent.type(input, '/Users/dev/custom-repo');
    await userEvent.click(screen.getByRole('button', { name: /use path/i }));

    expect(onChange).toHaveBeenCalledWith('/Users/dev/custom-repo');
  });

  it('opens the folder browser via "Browse folders…" and forwards the picked path', async () => {
    const onChange = vi.fn();
    render(<ProjectPicker onChange={onChange} />);

    await userEvent.click(await screen.findByRole('button', { name: /no repo/i }));
    await userEvent.click(await screen.findByRole('option', { name: /browse folders/i }));

    // The folder browser mock is now rendered; simulate a selection.
    expect(screen.getByTestId('folder-browser-mock')).toBeInTheDocument();
    await userEvent.click(screen.getByText('mock-pick'));

    expect(onChange).toHaveBeenCalledWith('/Users/dev/picked-repo');
  });
});
