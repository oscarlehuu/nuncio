import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeView } from './home-view';
import { saveModelPreference } from '../lib/model-preference';
import {
  recordBranchSelection,
  recordProjectSelection,
} from '../lib/project-preference';
import type { ModelProvider } from '../lib/model-providers';
import {
  createCrewTask,
  fetchCrewProfiles,
  resolveCrewProfile,
  type CrewProfileDto,
} from '@nuncio/core/crew-api';

vi.mock('@nuncio/core/crew-api', () => ({
  createCrewTask: vi.fn(),
  fetchCrewProfiles: vi.fn(),
  resolveCrewProfile: vi.fn(),
}));

const PI_ONLY_PROVIDERS: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Pi',
    groups: [{ id: 'g', name: 'G', models: [{ id: 'anthropic:claude-haiku-4', name: 'Haiku' }] }],
  },
];

const PI_MIXED_IMAGE_PROVIDERS: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Pi',
    capabilities: { images: true },
    groups: [
      {
        id: 'registry',
        name: 'Registry',
        models: [
          { id: 'google:gemini', name: 'Gemini', capabilities: { images: true } },
          { id: 'xai:grok', name: 'Grok', capabilities: { images: false } },
        ],
      },
    ],
  },
];

const CURSOR_AND_PI: ModelProvider[] = [
  ...PI_ONLY_PROVIDERS,
  {
    id: 'cursor',
    name: 'Cursor',
    groups: [{ id: 'c', name: 'C', models: [{ id: 'cursor:composer-2.5', name: 'Composer 2.5' }] }],
  },
];

const CODEX_ONLY_PROVIDERS: ModelProvider[] = [
  {
    id: 'codex',
    name: 'Codex',
    groups: [
      {
        id: 'codex',
        name: 'Codex',
        models: [{ id: 'codex:gpt-5.5', name: 'GPT 5.5' }],
      },
    ],
  },
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
    ...CREW_PROFILE.definition,
    presetId: 'quality' as const,
    sourceProfileId: CREW_PROFILE.id,
    sourceProfileRevision: CREW_PROFILE.revision,
    tester: { kind: 'nuncio' as const, runtimePolicy: 'read-only' as const },
    resolvedAt: 3,
  },
  issues: [],
};

vi.mock('../lib/api', () => ({
  fetchModels: vi.fn().mockResolvedValue([]),
}));

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
        <button
          type="button"
          disabled={!projectPath}
          onClick={() => onChange(value === 'main' ? 'release' : 'main')}
        >
          {value ?? 'Branch'}
        </button>
      );
    },
  };
});

describe('HomeView', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(fetchCrewProfiles).mockReset().mockResolvedValue([CREW_PROFILE]);
    vi.mocked(resolveCrewProfile).mockReset().mockResolvedValue(READY);
    vi.mocked(createCrewTask).mockReset().mockResolvedValue({
      task: { id: 'task-1', objective: 'Ship it', projectPath: '/code/nuncio', baseBranch: 'main', createdAt: 1, updatedAt: 1 },
      run: {} as never,
    });
  });

  it('submits the prompt on Enter', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} providers={CURSOR_AND_PI} />);
    const textarea = screen.getByPlaceholderText(/ask nuncio/i);
    await userEvent.type(textarea, 'Build a login page{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe('Build a login page');
  });

  it('does not submit on Enter when the prompt is empty and keeps Send disabled', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} providers={CURSOR_AND_PI} />);
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('enables Send once the prompt has content and submits on click', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} providers={CURSOR_AND_PI} />);
    const send = await screen.findByRole('button', { name: /send/i });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/ask nuncio/i), 'Ship it');
    expect(send).toBeEnabled();
    await userEvent.click(send);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe('Ship it');
  });

  it('submits on Enter (without shift) and not on Shift+Enter', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} providers={CURSOR_AND_PI} />);
    const textarea = screen.getByPlaceholderText(/ask nuncio/i);
    await userEvent.type(textarea, 'Fix the bug');
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await userEvent.type(textarea, 'more');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('removes the hero heading — the composer is the centerpiece', () => {
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);
    expect(screen.queryByText(/what should i work on/i)).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('renders the context row (project / branch / workspace) above the composer card', () => {
    const { container } = render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);
    const contextRow = container.querySelector('.home-composer-context-row');
    const card = container.querySelector('.home-composer');
    expect(contextRow).toBeTruthy();
    expect(card).toBeTruthy();

    // Context row sits BEFORE the composer card in document order.
    expect(
      contextRow!.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The three context triggers live in the context row, not the composer card.
    expect(contextRow).toContainElement(screen.getByRole('button', { name: /no repo/i }));
    expect(contextRow).toContainElement(screen.getByRole('button', { name: /work locally/i }));
    expect(card).not.toContainElement(screen.getByRole('button', { name: /no repo/i }));
  });

  it('keeps the model picker inside the composer bar as a single-row scroll', async () => {
    const { container } = render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);
    const card = container.querySelector('.home-composer');
    const bar = container.querySelector('.home-composer-bar');
    const pickers = container.querySelector('.home-composer-pickers');

    expect(card).toHaveClass('flex', 'flex-col');
    expect(bar).toBeTruthy();
    expect(pickers).toHaveClass('overflow-x-auto');
    expect(pickers).not.toHaveClass('flex-wrap');

    const model = await screen.findByRole('button', { name: /haiku/i });
    expect(bar).toContainElement(model);
  });

  it('keeps Codex on the shared model picker without exposing permission controls', async () => {
    const { container } = render(
      <HomeView
        sessionCount={0}
        onSubmit={vi.fn()}
        providers={CODEX_ONLY_PROVIDERS}
      />,
    );

    const model = await screen.findByRole('button', { name: /gpt 5.5/i });
    expect(screen.queryByRole('button', { name: /approval mode/i })).toBeNull();
    expect(container.querySelector('.home-composer-bar')).toContainElement(model);
    expect(container.querySelector('.home-composer-prompt-frame')).not.toContainElement(model);
  });

  it('forwards the selected project and branch as local workspace by default', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} providers={CURSOR_AND_PI} />);
    await userEvent.click(screen.getByRole('button', { name: /no repo/i }));
    expect(await screen.findByRole('button', { name: /^main$/i })).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText(/ask nuncio/i), 'Add workspace{Enter}');
    expect(onSubmit).toHaveBeenCalledWith(
      'Add workspace',
      'anthropic:claude-haiku-4',
      'pi',
      '/code/nuncio',
      'main',
      undefined,
      false,
      undefined,
    );
  });

  it('uses new worktree mode before forwarding the selected branch', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} providers={CURSOR_AND_PI} />);
    await userEvent.click(screen.getByRole('button', { name: /no repo/i }));
    await userEvent.click(screen.getByRole('button', { name: /work locally/i }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /new worktree/i }));
    expect(await screen.findByRole('button', { name: /^main$/i })).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText(/ask nuncio/i), 'Add worktree{Enter}');
    expect(onSubmit).toHaveBeenCalledWith(
      'Add worktree',
      'anthropic:claude-haiku-4',
      'pi',
      '/code/nuncio',
      'main',
      undefined,
      true,
      undefined,
    );
  });

  it('restores the last project and branch from localStorage', () => {
    recordProjectSelection('/code/nuncio', 'nuncio');
    recordBranchSelection('/code/nuncio', 'develop');
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);
    expect(screen.getByRole('button', { name: /^nuncio$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^develop$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /work locally/i })).toBeInTheDocument();
  });

  it('restores the last model selection from localStorage', async () => {
    saveModelPreference({
      modelId: 'anthropic:claude-haiku-4',
      providerId: 'pi',
    });
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);
    expect(await screen.findByRole('button', { name: /haiku/i })).toBeInTheDocument();
  });

  it('defaults to pi when cursor is not in the live catalog', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} providers={PI_ONLY_PROVIDERS} />);
    await userEvent.type(screen.getByPlaceholderText(/ask nuncio/i), 'Hello{Enter}');
    expect(onSubmit).toHaveBeenCalledWith(
      'Hello',
      'anthropic:claude-haiku-4',
      'pi',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
    );
  });

  it('gates image attachment by the selected Pi registry model', async () => {
    saveModelPreference({ modelId: 'xai:grok', providerId: 'pi' });
    const grok = render(
      <HomeView sessionCount={0} onSubmit={vi.fn()} providers={PI_MIXED_IMAGE_PROVIDERS} />,
    );
    expect(await screen.findByRole('button', { name: /grok/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /attach image/i })).toBeNull();
    grok.unmount();

    localStorage.clear();
    saveModelPreference({ modelId: 'google:gemini', providerId: 'pi' });
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={PI_MIXED_IMAGE_PROVIDERS} />);
    expect(await screen.findByRole('button', { name: /gemini/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /attach image/i })).toBeInTheDocument();
  });

  it('shows Continue on mobile icon in the composer bar when handler is provided', async () => {
    const onContinue = vi.fn();
    render(
      <HomeView
        sessionCount={0}
        onSubmit={vi.fn()}
        onContinueOnMobile={onContinue}
        providers={CURSOR_AND_PI}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /continue on mobile/i }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('starts every fresh composer in Solo mode', () => {
    const { unmount } = render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);
    expect(screen.getByRole('switch', { name: /crew/i })).toHaveAttribute('aria-checked', 'false');
    unmount();
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);
    expect(screen.getByRole('switch', { name: /crew/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('Crew mode swaps the Solo model for the configured crew profile', async () => {
    render(
      <HomeView sessionCount={0} onSubmit={vi.fn()} providers={CODEX_ONLY_PROVIDERS}
        onCrewCreated={vi.fn()} />,
    );
    expect(await screen.findByRole('button', { name: /gpt 5.5/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    expect(screen.queryByRole('button', { name: /gpt 5.5/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /crew profile: oscar quality crew/i })).toBeInTheDocument();
  });

  it('keeps the no-profile Crew state compact and actionable inside the toolbar', async () => {
    vi.mocked(fetchCrewProfiles).mockResolvedValue([]);
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);

    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));

    expect(await screen.findByRole('link', { name: /set up crew/i })).toHaveAttribute(
      'href',
      '/settings?section=crew-profiles',
    );
    expect(screen.queryByText(/no crew profile/i)).toBeNull();
    expect(screen.queryByRole('combobox', { name: /crew profile/i })).toBeNull();
  });

  it('keeps normal branch selection but hides Crew worktree implementation detail', async () => {
    const { container } = render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);
    expect(screen.getByRole('button', { name: /workspace mode: work locally/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /no repo/i }));
    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    expect(screen.queryByRole('button', { name: /workspace mode/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/crew worktree/i)).toBeNull();
    expect(screen.getByRole('button', { name: /^main$/i })).toBeInTheDocument();
    expect(container.querySelector('.home-composer-context-row')?.textContent?.trim()).not.toMatch(/·$/);

    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    expect(screen.getByRole('button', { name: /workspace mode: work locally/i })).toBeInTheDocument();
  });

  it('refreshes saved profiles whenever Crew mode is re-entered', async () => {
    const updated = { ...CREW_PROFILE, name: 'Updated Quality Crew', revision: 3 };
    vi.mocked(fetchCrewProfiles)
      .mockReset()
      .mockResolvedValueOnce([CREW_PROFILE])
      .mockResolvedValueOnce([updated]);
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);

    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    expect(await screen.findByRole('button', { name: /crew profile: oscar quality crew/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));

    expect(await screen.findByRole('button', { name: /crew profile: updated quality crew/i })).toBeInTheDocument();
    expect(fetchCrewProfiles).toHaveBeenCalledTimes(2);
  });

  it('resolves a Ready profile, creates once on double tap, and calls the lead route callback', async () => {
    const onCrewCreated = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} onCrewCreated={onCrewCreated} />);
    await userEvent.click(screen.getByRole('button', { name: /no repo/i }));
    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(resolveCrewProfile).toHaveBeenCalledWith(
      'quality', '/code/nuncio', 'main', expect.any(AbortSignal),
    );
    await userEvent.type(screen.getByPlaceholderText(/ask nuncio/i), 'Ship it');
    const send = screen.getByRole('button', { name: /send/i });
    expect(send).toBeEnabled();
    await userEvent.dblClick(send);
    expect(createCrewTask).toHaveBeenCalledTimes(1);
    expect(createCrewTask).toHaveBeenCalledWith({ objective: 'Ship it', projectPath: '/code/nuncio', baseBranch: 'main', profileId: 'quality' });
    expect(onCrewCreated).toHaveBeenCalledWith('task-1');
  });

  it('re-resolves Crew readiness when the selected base branch changes', async () => {
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);
    await userEvent.click(screen.getByRole('button', { name: /no repo/i }));
    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^main$/i }));

    await waitFor(() => expect(resolveCrewProfile).toHaveBeenCalledWith(
      'quality', '/code/nuncio', 'release', expect.any(AbortSignal),
    ));
  });

  it('Needs setup disables Delegate and links directly to Crew profile settings', async () => {
    vi.mocked(resolveCrewProfile).mockResolvedValue({ ...READY, state: 'needs_setup', issues: [{ code: 'MODEL_UNAVAILABLE', role: 'builder', message: 'Builder model unavailable' }] });
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} onCrewCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /no repo/i }));
    await userEvent.click(screen.getByRole('switch', { name: /crew/i }));
    expect(await screen.findByText('Needs setup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: /set up profile/i })).toHaveAttribute('href', '/settings?section=crew-profiles');
  });
});
