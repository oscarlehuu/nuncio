import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from './theme-provider';
import { FolderBrowser } from './folder-browser';
import type { DirListing } from '../lib/fs-api';

const mockFetchDirectories = vi.fn();

vi.mock('../lib/fs-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/fs-api')>();
  return { ...actual, fetchDirectories: (...args: unknown[]) => mockFetchDirectories(...args) };
});

function renderWithTheme(ui: ReactElement) {
  return render(<ThemeProvider defaultTheme="light">{ui}</ThemeProvider>);
}

function makeListing(over: Partial<DirListing> = {}): DirListing {
  return {
    current: '/Users/dev',
    parent: '/Users',
    entries: [
      { name: 'alpha', path: '/Users/dev/alpha', isGit: false },
      { name: 'beta-repo', path: '/Users/dev/beta-repo', isGit: true },
    ],
    ...over,
  };
}

describe('FolderBrowser', () => {
  beforeEach(() => {
    mockFetchDirectories.mockReset();
  });

  it('fetches directories on open and renders the current path + entries', async () => {
    mockFetchDirectories.mockResolvedValue(makeListing());
    renderWithTheme(<FolderBrowser open onSelect={vi.fn()} onCancel={vi.fn()} />);

    expect(await screen.findByText('/Users/dev')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta-repo')).toBeInTheDocument();
    expect(mockFetchDirectories).toHaveBeenCalledWith(undefined);
  });

  it('shows a git badge on git-repo entries', async () => {
    mockFetchDirectories.mockResolvedValue(makeListing());
    renderWithTheme(<FolderBrowser open onSelect={vi.fn()} onCancel={vi.fn()} />);

    await screen.findByText('beta-repo');
    // Exact lowercase match — the DialogDescription also contains "Git".
    expect(screen.getByText('git')).toBeInTheDocument();
  });

  it('navigates into a subdirectory when it is clicked', async () => {
    mockFetchDirectories
      .mockResolvedValueOnce(makeListing())
      .mockResolvedValueOnce(makeListing({ current: '/Users/dev/alpha', parent: '/Users/dev', entries: [] }));
    renderWithTheme(<FolderBrowser open onSelect={vi.fn()} onCancel={vi.fn()} />);

    await screen.findByText('alpha');
    await userEvent.click(screen.getByText('alpha'));

    await waitFor(() => expect(screen.getByText('/Users/dev/alpha')).toBeInTheDocument());
    expect(mockFetchDirectories).toHaveBeenNthCalledWith(2, '/Users/dev/alpha');
  });

  it('navigates up via the parent button', async () => {
    mockFetchDirectories
      .mockResolvedValueOnce(makeListing())
      .mockResolvedValueOnce(makeListing({ current: '/Users', parent: '/', entries: [] }));
    renderWithTheme(<FolderBrowser open onSelect={vi.fn()} onCancel={vi.fn()} />);

    await screen.findByText('alpha');
    await userEvent.click(screen.getByRole('button', { name: /parent/i }));

    await waitFor(() => expect(screen.getByText('/Users')).toBeInTheDocument());
    expect(mockFetchDirectories).toHaveBeenNthCalledWith(2, '/Users');
  });

  it('hides the parent button at the filesystem root', async () => {
    mockFetchDirectories.mockResolvedValue(makeListing({ current: '/', parent: null, entries: [] }));
    renderWithTheme(<FolderBrowser open onSelect={vi.fn()} onCancel={vi.fn()} />);

    await screen.findByText('/');
    expect(screen.queryByRole('button', { name: /parent/i })).not.toBeInTheDocument();
  });

  it('calls onSelect with the current path when Select is clicked', async () => {
    mockFetchDirectories.mockResolvedValue(makeListing());
    const onSelect = vi.fn();
    renderWithTheme(<FolderBrowser open onSelect={onSelect} onCancel={vi.fn()} />);

    await screen.findByText('alpha');
    await userEvent.click(screen.getByRole('button', { name: /select/i }));

    expect(onSelect).toHaveBeenCalledWith('/Users/dev');
  });

  it('calls onCancel when Cancel is clicked', async () => {
    mockFetchDirectories.mockResolvedValue(makeListing());
    const onCancel = vi.fn();
    renderWithTheme(<FolderBrowser open onSelect={vi.fn()} onCancel={onCancel} />);

    await screen.findByText('alpha');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a loading indicator while fetching', async () => {
    let resolveListing: (v: DirListing) => void = () => {};
    mockFetchDirectories.mockReturnValue(
      new Promise<DirListing>((resolve) => { resolveListing = resolve; }),
    );
    renderWithTheme(<FolderBrowser open onSelect={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/loading/i)).toBeInTheDocument());
    resolveListing(makeListing());
  });

  it('shows an error with a retry button when the fetch fails', async () => {
    mockFetchDirectories.mockRejectedValueOnce(new Error('boom'));
    renderWithTheme(<FolderBrowser open onSelect={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('retry refetches the current path', async () => {
    mockFetchDirectories
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeListing());
    renderWithTheme(<FolderBrowser open onSelect={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('alpha');
    expect(mockFetchDirectories).toHaveBeenCalledTimes(2);
  });

  it('shows an empty-state message when a directory has no subdirs', async () => {
    mockFetchDirectories.mockResolvedValue(makeListing({ entries: [] }));
    renderWithTheme(<FolderBrowser open onSelect={vi.fn()} onCancel={vi.fn()} />);

    await screen.findByText(/no subdirectories/i);
  });

  it('starts at a custom initialPath when provided', async () => {
    mockFetchDirectories.mockResolvedValue(makeListing({ current: '/custom' }));
    renderWithTheme(<FolderBrowser open initialPath="/custom" onSelect={vi.fn()} onCancel={vi.fn()} />);

    await screen.findByText('/custom');
    expect(mockFetchDirectories).toHaveBeenCalledWith('/custom');
  });
});
