import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionDetail } from './session-detail';
import type { Session, SessionEvent } from '../lib/api';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Build feature X',
    status: 'IDLE',
    provider: 'pi',
    model: 'claude-fable-5',
    prompt: 'do it',
    preview: null,
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now() - 120_000,
    ...overrides,
  };
}

const NO_EVENTS: SessionEvent[] = [];

async function renderDetail(overrides: Partial<Session> = {}) {
  const onSteer = vi.fn();
  const onPause = vi.fn();
  const onArchive = vi.fn();
  render(
    <SessionDetail
      session={makeSession(overrides)}
      events={NO_EVENTS}
      onBack={() => {}}
      onSteer={onSteer}
      onPause={onPause}
      onArchive={onArchive}
    />,
  );
  return { onSteer, onPause, onArchive };
}

describe('SessionDetail', () => {
  it('calls onSteer with the message when send is clicked', async () => {
    const { onSteer } = await renderDetail();
    const textarea = screen.getByPlaceholderText(/steer the agent/i);
    await userEvent.type(textarea, 'Use the cache layer');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSteer).toHaveBeenCalledWith('Use the cache layer');
  });

  it('calls onPause when the pause button is clicked', async () => {
    const { onPause } = await renderDetail();
    await userEvent.click(screen.getByRole('button', { name: /pause session/i }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('calls onArchive when the archive button is clicked', async () => {
    const { onArchive } = await renderDetail();
    await userEvent.click(screen.getByRole('button', { name: /archive session/i }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it('disables steering when the session is RUNNING', async () => {
    await renderDetail({ status: 'RUNNING' });
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('hides the pause button when the session is ARCHIVED', async () => {
    await renderDetail({ status: 'ARCHIVED' });
    expect(screen.queryByRole('button', { name: /pause session/i })).toBeNull();
  });
});
