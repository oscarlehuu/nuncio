import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrewProfilesSettingsSection } from './crew-profiles-settings-section';
import { createCrewProfile, deleteCrewProfile, fetchCrewProfiles, updateCrewProfile, type CrewProfileDto } from '@nuncio/core/crew-api';

vi.mock('@nuncio/core/crew-api', () => ({
  createCrewProfile: vi.fn(), deleteCrewProfile: vi.fn(), fetchCrewProfiles: vi.fn(), updateCrewProfile: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ fetchModels: vi.fn().mockResolvedValue([]) }));

describe('CrewProfilesSettingsSection', () => {
  beforeEach(() => {
    vi.mocked(fetchCrewProfiles).mockReset().mockResolvedValue([]);
    vi.mocked(createCrewProfile).mockReset();
    vi.mocked(updateCrewProfile).mockReset();
    vi.mocked(deleteCrewProfile).mockReset();
  });

  it('renders the empty state and opens a viewport-bounded new profile editor', async () => {
    render(<CrewProfilesSettingsSection />);
    expect(await screen.findByText(/no crew profiles yet/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /new profile/i }));
    const dialog = screen.getByRole('dialog', { name: /new crew profile/i });
    expect(dialog.className).toMatch(/max-h/);
    expect(screen.getByText(/nuncio tester/i)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: /max verify retries/i })).toHaveValue(2);
    expect(screen.getByRole('spinbutton', { name: /max review retries/i })).toHaveValue(2);
  });

  it('renders a saved profile with a revision badge and the shared roster (no Quality/Verify literals)', async () => {
    const profile = {
      id: 'p1', name: 'Quality Crew', revision: 2,
      presetId: 'quality', createdAt: 1, updatedAt: 2,
      definition: {
        bindings: {
          foreman: { provider: 'mock', model: 'mock:foreman', label: 'Fable' },
          builder: { provider: 'mock', model: 'mock:builder', label: 'Sol' },
          reviewer: { provider: 'mock', model: 'mock:reviewer', label: 'Opus' },
        },
        policy: { verifyCommand: null, maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true },
      },
    } satisfies CrewProfileDto;
    vi.mocked(fetchCrewProfiles).mockResolvedValue([profile]);
    render(<CrewProfilesSettingsSection />);
    expect(await screen.findByText('Quality Crew')).toBeInTheDocument();
    const roster = screen.getByLabelText(/crew roster/i);
    expect(roster).toHaveTextContent('Fable');
    expect(roster).toHaveTextContent('Sol');
    expect(roster).toHaveTextContent('Opus');
    expect(roster).not.toHaveTextContent('mock:foreman');
    expect(roster).toHaveTextContent('Nuncio Tester');
    expect(roster).not.toHaveTextContent('Verify');
    expect(screen.getByText(/revision 2/i)).toBeInTheDocument();
  });

  it('shows a load error with retry instead of a false empty state', async () => {
    vi.mocked(fetchCrewProfiles).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
    render(<CrewProfilesSettingsSection />);
    expect(await screen.findByText(/failed to load crew profiles/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(fetchCrewProfiles).toHaveBeenCalledTimes(2));
  });
});
