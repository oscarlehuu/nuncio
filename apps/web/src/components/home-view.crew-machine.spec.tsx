import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeView } from './home-view';
import type { ModelProvider } from '../lib/model-providers';
import {
  createCrewTask,
  fetchCrewProfiles,
  resolveCrewProfile,
  type CrewProfileDto,
} from '@nuncio/core/crew-api';
import { fetchHubMachines, type HubMachines } from '../lib/hub-api';

vi.mock('@nuncio/core/crew-api', () => ({
  createCrewTask: vi.fn(),
  fetchCrewProfiles: vi.fn(),
  resolveCrewProfile: vi.fn(),
}));

// Origin-absolute base for the chosen machine; '' means "this page's machine".
vi.mock('../lib/hub-api', () => ({
  fetchHubMachines: vi.fn(),
  currentMachine: () => null,
  machineApiBase: (machine: string | null) => (machine ? `https://hub.test/m/${machine}` : ''),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, fetchModels: vi.fn().mockResolvedValue([]) };
});

vi.mock('./project-picker', () => ({
  ProjectPicker: ({ value, onChange }: { value?: string; onChange: (path: string) => void }) => (
    <button type="button" onClick={() => onChange('/code/nuncio')}>
      {value ? value.split('/').pop() : 'No repo'}
    </button>
  ),
}));

vi.mock('./branch-picker', async () => {
  const React = await import('react');
  return {
    BranchPicker: ({
      projectPath,
      value,
      onChange,
    }: {
      projectPath?: string;
      value?: string;
      onChange: (branch: string) => void;
    }) => {
      React.useEffect(() => {
        if (projectPath && !value) onChange('main');
      }, [projectPath, value, onChange]);
      return (
        <button type="button" disabled={!projectPath}>
          {value ?? 'Branch'}
        </button>
      );
    },
  };
});

const PROVIDERS: ModelProvider[] = [
  { id: 'pi', name: 'Nuncio Engine', groups: [{ id: 'g', name: 'G', models: [{ id: 'anthropic:claude-haiku-4', name: 'Haiku' }] }] },
];

const CREW_PROFILE: CrewProfileDto = {
  id: 'quality', name: 'Oscar Quality Crew', revision: 2, presetId: 'quality',
  definition: {
    bindings: {
      foreman: { provider: 'claude', model: 'fable', label: 'Fable' },
      builder: { provider: 'codex', model: 'sol', label: 'Sol' },
      reviewer: { provider: 'claude', model: 'opus', label: 'Opus' },
    },
    policy: { verifyCommand: 'bun test', maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true },
  },
  createdAt: 1, updatedAt: 2,
};
const READY = {
  state: 'ready' as const,
  snapshot: {
    ...CREW_PROFILE.definition, presetId: 'quality' as const,
    sourceProfileId: CREW_PROFILE.id, sourceProfileRevision: CREW_PROFILE.revision,
    tester: { kind: 'nuncio' as const, runtimePolicy: 'read-only' as const }, resolvedAt: 3,
  },
  issues: [],
};

const HUB: HubMachines = {
  hubMode: true,
  machines: [
    { name: 'mac-mini', dnsName: 'mac-mini.tail', origin: 'https://mac-mini.tail', os: 'macos', self: true },
    { name: 'studio', dnsName: 'studio.tail', origin: 'https://studio.tail', os: 'macos', self: false },
  ],
};

describe('HomeView Crew machine routing', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(fetchCrewProfiles).mockReset().mockResolvedValue([CREW_PROFILE]);
    vi.mocked(resolveCrewProfile).mockReset().mockResolvedValue(READY);
    vi.mocked(createCrewTask).mockReset().mockResolvedValue({
      task: { id: 'task-9', objective: 'Ship it', projectPath: '/code/nuncio', baseBranch: 'main', createdAt: 1, updatedAt: 1 },
      run: {} as never,
    });
    vi.mocked(fetchHubMachines).mockReset().mockResolvedValue(HUB);
  });

  it('routes create/resolve/profile calls to the chosen machine and hands its id to the router', async () => {
    const onCrewCreated = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={PROVIDERS} onCrewCreated={onCrewCreated} />);

    // Enter Crew, then target the remote machine before choosing a repo on it.
    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    await userEvent.click(await screen.findByRole('button', { name: /run on machine: mac-mini/i }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'studio' }));
    await userEvent.click(screen.getByRole('button', { name: /no repo/i }));

    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(resolveCrewProfile).toHaveBeenLastCalledWith(
      'quality', '/code/nuncio', 'main', expect.any(AbortSignal), 'https://hub.test/m/studio',
    );

    await userEvent.type(screen.getByPlaceholderText(/ask nuncio/i), 'Ship it');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(createCrewTask).toHaveBeenCalledWith(
      { objective: 'Ship it', projectPath: '/code/nuncio', baseBranch: 'main', profileId: 'quality' },
      'https://hub.test/m/studio',
    );
    // The run lives on studio: the router receives its id so it can navigate there.
    expect(onCrewCreated).toHaveBeenCalledWith('task-9', 'studio');
  });

  it('keeps the profile list re-fetched from the selected machine', async () => {
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={PROVIDERS} onCrewCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    await userEvent.click(await screen.findByRole('button', { name: /run on machine: mac-mini/i }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'studio' }));

    // Listed locally on entry, then re-listed from the machine that will own the run.
    expect(fetchCrewProfiles).toHaveBeenCalledWith('');
    expect(fetchCrewProfiles).toHaveBeenLastCalledWith('https://hub.test/m/studio');
  });

  it('hides the machine picker on single-machine installs', async () => {
    vi.mocked(fetchHubMachines).mockResolvedValue({ hubMode: false, machines: [] });
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={PROVIDERS} onCrewCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    expect(await screen.findByRole('button', { name: /crew profile: oscar quality crew/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run on machine/i })).toBeNull();
  });

  it('drops the remote target when switching back to Solo so create stays local', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} providers={PROVIDERS} onCrewCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    await userEvent.click(await screen.findByRole('button', { name: /run on machine: mac-mini/i }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'studio' }));
    // Back to Solo: the machine picker is gone and the target reverts to local.
    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    expect(screen.queryByRole('button', { name: /run on machine/i })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /no repo/i }));
    await userEvent.type(screen.getByPlaceholderText(/ask nuncio/i), 'Local task{Enter}');
    // Solo goes through onSubmit (always local) — never a remote create.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(createCrewTask).not.toHaveBeenCalled();
  });
});
