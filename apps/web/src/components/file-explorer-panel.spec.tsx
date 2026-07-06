import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileExplorerPanel } from './file-explorer-panel';
import { deleteEntry, listEntries, readFile, writeFile } from '../lib/fs-api';

vi.mock('../lib/fs-api', () => ({
  listEntries: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  makeDir: vi.fn(),
  renameEntry: vi.fn(),
  deleteEntry: vi.fn(),
}));

const rootListing = {
  root: '/workspace',
  path: '',
  parent: null,
  entries: [
    { name: 'src', path: 'src', kind: 'dir' as const },
    { name: '.env', path: '.env', kind: 'file' as const, size: 8 },
    { name: 'README.md', path: 'README.md', kind: 'file' as const, size: 7 },
    { name: 'config.json', path: 'config.json', kind: 'file' as const, size: 20 },
    { name: 'deploy.yaml', path: 'deploy.yaml', kind: 'file' as const, size: 15 },
  ],
};

const srcListing = {
  root: '/workspace',
  path: 'src',
  parent: '',
  entries: [{ name: 'app.ts', path: 'src/app.ts', kind: 'file' as const, size: 17 }],
};

describe('FileExplorerPanel', () => {
  beforeEach(() => {
    vi.mocked(listEntries).mockReset();
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset();
    vi.mocked(deleteEntry).mockReset();
    vi.mocked(listEntries).mockImplementation(async (_root, path = '') =>
      path === 'src' ? srcListing : rootListing,
    );
    vi.mocked(readFile).mockResolvedValue({
      path: 'README.md',
      content: '# Hello',
      encoding: 'utf8',
      truncated: false,
      size: 7,
    });
    vi.mocked(writeFile).mockResolvedValue({ path: 'README.md', size: 10 });
    vi.mocked(deleteEntry).mockResolvedValue({ path: 'README.md' });
  });

  it('renders a tree from listEntries and lazy-loads children when expanding a folder', async () => {
    render(<FileExplorerPanel root="/workspace" />);

    expect(await screen.findByRole('button', { name: /src/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /README\.md/i })).toBeInTheDocument();
    expect(listEntries).toHaveBeenCalledWith('/workspace', '');

    await userEvent.click(screen.getByRole('button', { name: /src/i }));

    expect(await screen.findByRole('button', { name: /app\.ts/i })).toBeInTheDocument();
    expect(listEntries).toHaveBeenCalledWith('/workspace', 'src');
  });

  it('opens a requested source path by expanding its parent folder', async () => {
    vi.mocked(readFile).mockResolvedValue({
      path: 'src/app.ts',
      content: 'export const app = true;',
      encoding: 'utf8',
      truncated: false,
      size: 24,
    });

    render(<FileExplorerPanel root="/workspace" openPath="src/app.ts" />);

    expect(await screen.findByRole('button', { name: /app\.ts/i })).toBeInTheDocument();
    expect(readFile).toHaveBeenCalledWith('/workspace', 'src/app.ts');
    expect(await screen.findByLabelText(/file editor/i)).toHaveValue('export const app = true;');
  });

  it('opens markdown files in preview mode by default with an Edit toggle', async () => {
    render(<FileExplorerPanel root="/workspace" />);

    await userEvent.click(await screen.findByRole('button', { name: /README\.md/i }));

    expect(await screen.findByRole('heading', { name: 'Hello' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/file editor/i)).toBeNull();

    const toggle = screen.getByRole('button', { name: /edit/i });
    expect(toggle).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(screen.getByLabelText(/file editor/i)).toHaveValue('# Hello');
    expect(screen.queryByRole('heading', { name: 'Hello' })).toBeNull();
  });

  it('opens non-markdown files in the editor by default', async () => {
    vi.mocked(readFile).mockResolvedValue({
      path: 'config.json',
      content: '{"a":1}',
      encoding: 'utf8',
      truncated: false,
      size: 20,
    });
    render(<FileExplorerPanel root="/workspace" />);

    await userEvent.click(await screen.findByRole('button', { name: /config\.json/i }));

    expect(await screen.findByLabelText(/file editor/i)).toHaveValue('{"a":1}');
    expect(screen.getByRole('button', { name: /preview/i })).toBeInTheDocument();
  });

  it('selects a file, shows content in the editor, enables Save when dirty, and writes new content', async () => {
    render(<FileExplorerPanel root="/workspace" />);

    await userEvent.click(await screen.findByRole('button', { name: /README\.md/i }));
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    const editor = await screen.findByLabelText(/file editor/i);
    expect(editor).toHaveValue('# Hello');
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();

    await userEvent.clear(editor);
    await userEvent.type(editor, '# Changed');
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(writeFile).toHaveBeenCalledWith('/workspace', 'README.md', '# Changed');
  });

  it('shows binary and too-large placeholders without an editor', async () => {
    vi.mocked(readFile).mockResolvedValueOnce({ path: 'README.md', binary: true, size: 3 });
    const { rerender } = render(<FileExplorerPanel root="/workspace" />);

    await userEvent.click(await screen.findByRole('button', { name: /README\.md/i }));
    expect(await screen.findByText(/binary file/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/file editor/i)).toBeNull();

    vi.mocked(readFile).mockResolvedValueOnce({
      path: 'README.md',
      encoding: 'utf8',
      truncated: true,
      size: 1024 * 1024 + 1,
    });
    rerender(<FileExplorerPanel root="/workspace" />);
    await userEvent.click(screen.getByRole('button', { name: /README\.md/i }));
    expect(await screen.findByText(/file too large to preview/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/file editor/i)).toBeNull();
  });

  it('shows the preview toggle for a .json file and pretty-prints valid JSON', async () => {
    vi.mocked(readFile).mockResolvedValue({
      path: 'config.json',
      content: '{"a":1,"b":[2,3]}',
      encoding: 'utf8',
      truncated: false,
      size: 20,
    });
    render(<FileExplorerPanel root="/workspace" />);

    await userEvent.click(await screen.findByRole('button', { name: /config\.json/i }));
    await screen.findByLabelText(/file editor/i);

    const toggle = screen.getByRole('button', { name: /preview/i });
    await userEvent.click(toggle);

    expect(screen.getByText('JSON')).toBeInTheDocument();
    const code = document.querySelector('pre code');
    expect(code?.textContent).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
    expect(screen.queryByLabelText(/file editor/i)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.getByLabelText(/file editor/i)).toBeInTheDocument();
  });

  it('shows an invalid-JSON note with raw content for malformed JSON', async () => {
    vi.mocked(readFile).mockResolvedValue({
      path: 'config.json',
      content: '{not json',
      encoding: 'utf8',
      truncated: false,
      size: 9,
    });
    render(<FileExplorerPanel root="/workspace" />);

    await userEvent.click(await screen.findByRole('button', { name: /config\.json/i }));
    await screen.findByLabelText(/file editor/i);
    await userEvent.click(screen.getByRole('button', { name: /preview/i }));

    expect(screen.getByText(/invalid json:/i)).toBeInTheDocument();
    const code = document.querySelector('pre code');
    expect(code?.textContent).toBe('{not json');
  });

  it('renders a .yaml file in a code block with YAML label', async () => {
    vi.mocked(readFile).mockResolvedValue({
      path: 'deploy.yaml',
      content: 'name: test\nvalue: 1',
      encoding: 'utf8',
      truncated: false,
      size: 15,
    });
    render(<FileExplorerPanel root="/workspace" />);

    await userEvent.click(await screen.findByRole('button', { name: /deploy\.yaml/i }));
    await screen.findByLabelText(/file editor/i);
    await userEvent.click(screen.getByRole('button', { name: /preview/i }));

    expect(screen.getByText('YAML')).toBeInTheDocument();
    const code = document.querySelector('pre code');
    expect(code?.textContent).toBe('name: test\nvalue: 1');
  });

  it('deletes the selected file after confirmation and refreshes the parent listing', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FileExplorerPanel root="/workspace" />);

    await userEvent.click(await screen.findByRole('button', { name: /README\.md/i }));
    await screen.findByRole('button', { name: /edit/i });
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(deleteEntry).toHaveBeenCalledWith('/workspace', 'README.md');
    await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(2));
    confirmSpy.mockRestore();
  });
});
