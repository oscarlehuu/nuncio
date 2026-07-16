import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./home-view', () => ({
  HomeView: ({ onCrewCreated }: { onCrewCreated?: (taskId: string, machine?: string | null) => void }) => (
    <>
      <button type="button" onClick={() => onCrewCreated?.('task-1', null)}>Create local Crew fixture</button>
      <button type="button" onClick={() => onCrewCreated?.('task-2', 'studio')}>Create remote Crew fixture</button>
    </>
  ),
}));
vi.mock('./digest-card', () => ({ DigestCard: () => null }));
vi.mock('./attention-queue', () => ({ AttentionQueue: () => null }));
vi.mock('./crew/recent-crew-runs', () => ({ RecentCrewRuns: () => null }));

import { HomeSurface } from './home-surface';

describe('HomeSurface Crew routing', () => {
  const renderSurface = (onCrewCreated: (taskId: string, machine?: string | null) => void) =>
    render(
      <MemoryRouter>
        <HomeSurface
          sessionCount={0}
          providers={[]}
          onSubmit={vi.fn().mockResolvedValue(undefined)}
          onCrewCreated={onCrewCreated}
        />
      </MemoryRouter>,
    );

  it('forwards a local CrewTask id with no owning machine', async () => {
    const onCrewCreated = vi.fn();
    renderSurface(onCrewCreated);
    await userEvent.click(screen.getByRole('button', { name: 'Create local Crew fixture' }));
    expect(onCrewCreated).toHaveBeenCalledWith('task-1', null);
  });

  it('forwards the owning machine so the router can navigate to it', async () => {
    const onCrewCreated = vi.fn();
    renderSurface(onCrewCreated);
    await userEvent.click(screen.getByRole('button', { name: 'Create remote Crew fixture' }));
    expect(onCrewCreated).toHaveBeenCalledWith('task-2', 'studio');
  });
});
