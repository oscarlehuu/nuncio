import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, fetchProjectConfigs: vi.fn(), upsertProjectConfig: vi.fn() };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectsSettingsSection } from './projects-settings-section';
import { fetchProjectConfigs, upsertProjectConfig, type ProjectConfigDto } from '../lib/api';

function config(partial: Partial<ProjectConfigDto>): ProjectConfigDto {
  return {
    path: partial.path ?? '/Users/me/nuncio',
    name: partial.name ?? 'nuncio',
    defaultEngine: partial.defaultEngine ?? null,
    worktreePolicy: partial.worktreePolicy ?? null,
    verifyCommand: partial.verifyCommand ?? null,
    verifyAutoSteer: partial.verifyAutoSteer ?? 'inherit',
    verifyMaxRounds: partial.verifyMaxRounds ?? null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('ProjectsSettingsSection', () => {
  beforeEach(() => {
    vi.mocked(fetchProjectConfigs).mockReset();
    vi.mocked(upsertProjectConfig).mockReset().mockResolvedValue(config({}));
  });

  it('explains the inherit default when no projects are configured', async () => {
    vi.mocked(fetchProjectConfigs).mockResolvedValue([]);
    render(<ProjectsSettingsSection />);
    await waitFor(() => expect(screen.getByText(/No per-project overrides yet/i)).toBeInTheDocument());
  });

  it('lists a project with its overrides as badges', async () => {
    vi.mocked(fetchProjectConfigs).mockResolvedValue([
      config({ name: 'nuncio', defaultEngine: 'codex', worktreePolicy: 'always', verifyCommand: 'bun test' }),
    ]);
    render(<ProjectsSettingsSection />);
    await waitFor(() => expect(screen.getByText('nuncio')).toBeInTheDocument());
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('worktree: always')).toBeInTheDocument();
    expect(screen.getByText('custom verify')).toBeInTheDocument();
  });

  it('saves an edited verify command through the upsert client', async () => {
    vi.mocked(fetchProjectConfigs).mockResolvedValue([config({ name: 'nuncio' })]);
    render(<ProjectsSettingsSection />);
    await waitFor(() => expect(screen.getByText('nuncio')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /edit nuncio config/i }));
    const input = await screen.findByLabelText('Verify command');
    await userEvent.type(input, 'bun run check');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(upsertProjectConfig).toHaveBeenCalled());
    expect(vi.mocked(upsertProjectConfig).mock.calls[0]![0]).toMatchObject({
      path: '/Users/me/nuncio',
      verifyCommand: 'bun run check',
    });
  });
});
