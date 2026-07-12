import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./home-view', () => ({
  HomeView: ({ onCrewCreated }: { onCrewCreated?: (taskId: string) => void }) => (
    <button type="button" onClick={() => onCrewCreated?.('task-1')}>Create Crew fixture</button>
  ),
}));
vi.mock('./digest-card', () => ({ DigestCard: () => null }));
vi.mock('./attention-queue', () => ({ AttentionQueue: () => null }));
vi.mock('./crew/recent-crew-runs', () => ({ RecentCrewRuns: () => null }));

import { HomeSurface } from './home-surface';

describe('HomeSurface Crew routing', () => {
  it('forwards the durable CrewTask id from the composer', async () => {
    const onCrewCreated = vi.fn();
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

    await userEvent.click(screen.getByRole('button', { name: 'Create Crew fixture' }));
    expect(onCrewCreated).toHaveBeenCalledWith('task-1');
  });
});
