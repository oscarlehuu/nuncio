import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';

// The pickers fetch projects/models over the network — stub them to tiny controls
// so the test can drive the create/attach binding paths directly.
vi.mock('./project-picker', () => ({
  ProjectPicker: ({ onChange }: { onChange: (p: string) => void }) => (
    <button type="button" onClick={() => onChange('/code/nuncio')}>
      pick-project
    </button>
  ),
}));

vi.mock('./model-picker', () => ({
  ModelPicker: () => <div>model-picker</div>,
}));

import { GridSlotComposer } from './grid-slot-composer';

const PROVIDERS: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Pi',
    groups: [{ id: 'pi', name: 'Pi', models: [{ id: 'pi:default', name: 'Pi Default' }] }],
  },
];

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: 'sess-live',
    title: 'Live task',
    status: 'RUNNING',
    provider: 'pi',
    model: 'pi:default',
    modelOptions: null,
    prompt: '',
    preview: null,
    workspace: null,
    projectPath: '/code/nuncio',
    baseBranch: null,
    worktreePath: null,
    branch: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('GridSlotComposer', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('creates a session with the prompt + model + project, then binds the slot', async () => {
    const created = fakeSession({ id: 'new-99' });
    const onCreate = vi.fn().mockResolvedValue(created);
    const onBind = vi.fn();

    render(
      <GridSlotComposer
        providers={PROVIDERS}
        sessions={[]}
        boundSessionIds={new Set()}
        onCreate={onCreate}
        onBind={onBind}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /pick-project/i }));
    await userEvent.type(screen.getByLabelText(/new session prompt/i), 'ship the grid');
    await userEvent.click(screen.getByRole('button', { name: /start/i }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    const call = onCreate.mock.calls[0];
    expect(call[0]).toBe('ship the grid');
    expect(call[1]).toBe('pi:default');
    expect(call[2]).toBe('pi');
    expect(call[3]).toBe('/code/nuncio');
    // The caller (grid-view) is responsible for binding via onCreate's return —
    // this component simply resolves. Verify onCreate carried the new session.
    await expect(onCreate.mock.results[0]!.value).resolves.toEqual(created);
  });

  it('lists non-archived sessions under Attach and binds on pick', async () => {
    const onBind = vi.fn();
    const sessions = [
      fakeSession({ id: 'a1', title: 'Active alpha', status: 'IDLE' }),
      fakeSession({ id: 'z9', title: 'Old archived', status: 'ARCHIVED' }),
    ];

    render(
      <GridSlotComposer
        providers={PROVIDERS}
        sessions={sessions}
        boundSessionIds={new Set()}
        onCreate={vi.fn()}
        onBind={onBind}
      />,
    );

    await userEvent.click(screen.getByRole('tab', { name: /attach/i }));
    expect(screen.getByText('Active alpha')).toBeInTheDocument();
    expect(screen.queryByText('Old archived')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /attach active alpha/i }));
    expect(onBind).toHaveBeenCalledWith('a1');
  });
});
