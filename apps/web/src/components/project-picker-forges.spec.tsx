import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Command, CommandList } from '@/components/ui/command';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, fetchForgeRepos: vi.fn(), cloneForgeRepo: vi.fn() };
});
vi.mock('../lib/forge-status-api', () => ({ fetchForgeStatus: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectPickerForges } from './project-picker-forges';
import { fetchForgeRepos, cloneForgeRepo } from '../lib/api';
import { fetchForgeStatus, type ForgeStatusDto } from '../lib/forge-status-api';

function forge(partial: Partial<ForgeStatusDto>): ForgeStatusDto {
  return {
    id: partial.id ?? 'github',
    name: partial.name ?? 'GitHub',
    connected: partial.connected ?? true,
    login: partial.login ?? 'octo',
    method: 'cli',
    reason: partial.reason ?? null,
  };
}

function renderForges(onSelectPath = vi.fn(), query = '') {
  return render(
    <Command>
      <CommandList>
        <ProjectPickerForges query={query} onSelectPath={onSelectPath} active />
      </CommandList>
    </Command>,
  );
}

describe('ProjectPickerForges', () => {
  beforeEach(() => {
    vi.mocked(fetchForgeStatus).mockReset();
    vi.mocked(fetchForgeRepos).mockReset().mockResolvedValue([]);
    vi.mocked(cloneForgeRepo).mockReset();
  });

  it('collapses connected forge repos by default and expands on header click', async () => {
    vi.mocked(fetchForgeStatus).mockResolvedValue([forge({ connected: true })]);
    vi.mocked(fetchForgeRepos).mockResolvedValue([
      { id: '1', fullName: 'octo/nuncio', name: 'nuncio', description: 'the ADE', private: false, defaultBranch: 'main', cloneUrl: 'https://x/nuncio.git', webUrl: 'https://x/nuncio', updatedAt: null },
    ]);
    renderForges();

    const header = await screen.findByRole('button', { name: /github repos.*1/i });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('octo/nuncio')).not.toBeInTheDocument();

    await userEvent.click(header);

    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('octo/nuncio')).toBeInTheDocument();
  });

  it('clones a repo after expanding its forge section', async () => {
    vi.mocked(fetchForgeStatus).mockResolvedValue([forge({ connected: true })]);
    vi.mocked(fetchForgeRepos).mockResolvedValue([
      { id: '1', fullName: 'octo/nuncio', name: 'nuncio', description: 'the ADE', private: false, defaultBranch: 'main', cloneUrl: 'https://x/nuncio.git', webUrl: 'https://x/nuncio', updatedAt: null },
    ]);
    vi.mocked(cloneForgeRepo).mockResolvedValue({ path: '/Users/me/nuncio' });
    const onSelectPath = vi.fn();
    renderForges(onSelectPath);

    await userEvent.click(await screen.findByRole('button', { name: /github repos.*1/i }));
    await userEvent.click(screen.getByText('octo/nuncio'));
    await waitFor(() => expect(cloneForgeRepo).toHaveBeenCalled());
    expect(cloneForgeRepo).toHaveBeenCalledWith({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://x/nuncio.git',
      private: false,
    });
    expect(onSelectPath).toHaveBeenCalledWith('/Users/me/nuncio');
  });

  it('auto-expands matching forge sections while searching', async () => {
    vi.mocked(fetchForgeStatus).mockResolvedValue([forge({ connected: true })]);
    vi.mocked(fetchForgeRepos).mockResolvedValue([
      { id: '1', fullName: 'octo/nuncio', name: 'nuncio', description: 'the ADE', private: false, defaultBranch: 'main', cloneUrl: 'https://x/nuncio.git', webUrl: 'https://x/nuncio', updatedAt: null },
      { id: '2', fullName: 'octo/mobile', name: 'mobile', description: null, private: false, defaultBranch: 'main', cloneUrl: 'https://x/mobile.git', webUrl: 'https://x/mobile', updatedAt: null },
    ]);
    renderForges(vi.fn(), 'nuncio');

    const header = await screen.findByRole('button', { name: /github repos.*2/i });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('octo/nuncio')).toBeInTheDocument();
    expect(screen.queryByText('octo/mobile')).not.toBeInTheDocument();
  });

  it('shows a disabled reason for a disconnected forge — never an auth prompt', async () => {
    vi.mocked(fetchForgeStatus).mockResolvedValue([
      forge({ id: 'gitlab', name: 'GitLab', connected: false, reason: 'Connect GitLab in Settings to browse repositories.' }),
    ]);
    renderForges();
    await waitFor(() =>
      expect(screen.getByText('Connect GitLab in Settings to browse repositories.')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /sign in|authorize|connect now/i })).not.toBeInTheDocument();
  });

  it('renders nothing when there are no forges', async () => {
    vi.mocked(fetchForgeStatus).mockResolvedValue([]);
    const { container } = renderForges();
    await waitFor(() => expect(fetchForgeStatus).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
