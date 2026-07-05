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

// BranchPicker fetches base branches over the network — stub it so create/attach
// paths stay offline and deterministic.
vi.mock('./branch-picker', () => ({
  BranchPicker: ({
    projectPath,
    value,
    onChange,
  }: {
    projectPath?: string;
    value?: string;
    onChange: (branch: string) => void;
  }) => (
    <button type="button" disabled={!projectPath} onClick={() => onChange('main')}>
      {value ?? 'Branch'}
    </button>
  ),
}));

// Hub discovery + the remote-machine API surface, controllable per test.
const hubMocks = vi.hoisted(() => ({
  fetchHubMachines: vi.fn<() => Promise<import('../lib/hub-api').HubMachines>>(async () => ({
    hubMode: false,
    machines: [],
  })),
}));
vi.mock('../lib/hub-api', async () => {
  const actual = await vi.importActual<typeof import('../lib/hub-api')>('../lib/hub-api');
  return { ...actual, fetchHubMachines: hubMocks.fetchHubMachines };
});

const apiMocks = vi.hoisted(() => ({
  fetchModels: vi.fn<() => Promise<import('../lib/model-providers').ModelProvider[]>>(
    async () => [],
  ),
  fetchSessions: vi.fn<() => Promise<import('../lib/api').Session[]>>(async () => []),
  createSession: vi.fn<(typeof import('../lib/api'))['createSession']>(),
}));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    fetchModels: apiMocks.fetchModels,
    fetchSessions: apiMocks.fetchSessions,
    createSession: apiMocks.createSession,
  };
});

import { GridSlotComposer } from './grid-slot-composer';

const HUB_MACHINES = {
  hubMode: true,
  machines: [
    { name: 'macbook', dnsName: 'macbook.ts.net', origin: 'http://macbook:3000', os: 'macos', self: true },
    { name: 'studio', dnsName: 'studio.ts.net', origin: 'http://studio:3000', os: 'macos', self: false },
  ],
};

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
    vi.clearAllMocks();
    hubMocks.fetchHubMachines.mockResolvedValue({ hubMode: false, machines: [] });
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
    // Workspace mode defaults to local: no worktree unless the user picks it.
    expect(call[6]).toBe(false);
    // The caller (grid-view) is responsible for binding via onCreate's return —
    // this component simply resolves. Verify onCreate carried the new session.
    await expect(onCreate.mock.results[0]!.value).resolves.toEqual(created);
  });

  it('creates in a new worktree when the workspace mode is switched', async () => {
    const created = fakeSession({ id: 'new-wt' });
    const onCreate = vi.fn().mockResolvedValue(created);

    render(
      <GridSlotComposer
        providers={PROVIDERS}
        sessions={[]}
        boundSessionIds={new Set()}
        onCreate={onCreate}
        onBind={vi.fn()}
      />,
    );

    // A project must be selected before the worktree mode can be chosen.
    await userEvent.click(screen.getByRole('button', { name: /pick-project/i }));
    await userEvent.click(screen.getByRole('button', { name: /workspace mode/i }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /new worktree/i }));
    await userEvent.type(screen.getByLabelText(/new session prompt/i), 'fork it');
    await userEvent.click(screen.getByRole('button', { name: /start/i }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    const call = onCreate.mock.calls[0];
    expect(call[3]).toBe('/code/nuncio');
    expect(call[6]).toBe(true);
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
    expect(onBind).toHaveBeenCalledWith('a1', undefined);
  });

  it('shows no machine picker outside hub mode', async () => {
    render(
      <GridSlotComposer
        providers={PROVIDERS}
        sessions={[]}
        boundSessionIds={new Set()}
        onCreate={vi.fn()}
        onBind={vi.fn()}
      />,
    );
    await waitFor(() => expect(hubMocks.fetchHubMachines).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /choose machine/i })).not.toBeInTheDocument();
  });

  it('hub mode: attaching from a remote machine binds with that machineId', async () => {
    hubMocks.fetchHubMachines.mockResolvedValue(HUB_MACHINES);
    apiMocks.fetchSessions.mockResolvedValue([
      fakeSession({ id: 'r1', title: 'Remote run', status: 'IDLE' }),
    ]);
    const onBind = vi.fn();

    render(
      <GridSlotComposer
        providers={PROVIDERS}
        sessions={[]}
        boundSessionIds={new Set()}
        onCreate={vi.fn()}
        onBind={onBind}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: /choose machine/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /use machine studio/i }));
    await userEvent.click(screen.getByRole('tab', { name: /attach/i }));

    await userEvent.click(await screen.findByRole('button', { name: /attach remote run/i }));

    expect(apiMocks.fetchSessions).toHaveBeenCalledWith(expect.stringContaining('/m/studio'));
    expect(onBind).toHaveBeenCalledWith('r1', 'studio');
  });

  it('hub mode: creating on a remote machine targets its API and binds with the machineId', async () => {
    hubMocks.fetchHubMachines.mockResolvedValue(HUB_MACHINES);
    apiMocks.fetchModels.mockResolvedValue(PROVIDERS);
    apiMocks.createSession.mockResolvedValue(fakeSession({ id: 'new-r' }));
    const onCreate = vi.fn();
    const onBind = vi.fn();

    render(
      <GridSlotComposer
        providers={[]}
        sessions={[]}
        boundSessionIds={new Set()}
        onCreate={onCreate}
        onBind={onBind}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: /choose machine/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /use machine studio/i }));
    // Remote model catalog loads and resolves a default model.
    await waitFor(() =>
      expect(apiMocks.fetchModels).toHaveBeenCalledWith(expect.stringContaining('/m/studio')),
    );

    await userEvent.type(screen.getByLabelText(/new session prompt/i), 'run remotely');
    const start = screen.getByRole('button', { name: /start/i });
    await waitFor(() => expect(start).toBeEnabled());
    await userEvent.click(start);

    await waitFor(() => expect(onBind).toHaveBeenCalledWith('new-r', 'studio'));
    expect(apiMocks.createSession).toHaveBeenCalled();
    const call = apiMocks.createSession.mock.calls[0]!;
    expect(call[0]).toBe('run remotely');
    expect(call[7]).toEqual(expect.stringContaining('/m/studio'));
    // The local create path (App's handler) must not fire for remote creates.
    expect(onCreate).not.toHaveBeenCalled();
  });
});
