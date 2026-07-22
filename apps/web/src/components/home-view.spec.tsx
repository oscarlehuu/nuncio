import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeView } from './home-view';
import { AGENTS_MD_GENERATION_PROMPT } from '../lib/agents-md-prompt';
import {
  loadModelPreference,
  loadScopedModelPreference,
  saveModelPreference,
} from '../lib/model-preference';
import {
  recordBranchSelection,
  recordProjectSelection,
} from '../lib/project-preference';
import type { ModelProvider } from '../lib/model-providers';

const PI_ONLY_PROVIDERS: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Nuncio Engine',
    groups: [{ id: 'g', name: 'G', models: [{ id: 'anthropic:claude-haiku-4', name: 'Haiku' }] }],
  },
];

const PI_MIXED_IMAGE_PROVIDERS: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Nuncio Engine',
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

const PI_WITH_MODES: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Nuncio Engine',
    capabilities: { modes: ['debug', 'multitask'] },
    groups: [{ id: 'g', name: 'G', models: [{ id: 'anthropic:claude-haiku-4', name: 'Haiku' }] }],
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

  it('offers a Generate AGENTS.md quick action once a project is selected', async () => {
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);
    // Hidden until a project is picked — the prompt needs a repo to analyze.
    expect(screen.queryByRole('button', { name: /agents\.md/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /no repo/i }));
    const action = await screen.findByRole('button', { name: /agents\.md/i });
    await userEvent.click(action);
    const textarea = screen.getByPlaceholderText(/ask nuncio/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe(AGENTS_MD_GENERATION_PROMPT);
    expect(textarea.value).toContain('operating manual');
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
      undefined,
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
      undefined,
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

  it('persists Home selection in its own scope without changing the global default', async () => {
    saveModelPreference({
      modelId: 'anthropic:claude-haiku-4',
      providerId: 'pi',
    });
    const view = render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);

    await userEvent.click(await screen.findByRole('button', { name: /haiku/i }));
    await userEvent.click(await screen.findByText('Composer 2.5'));

    expect(await screen.findByRole('button', { name: /composer 2.5/i })).toBeInTheDocument();
    expect(loadScopedModelPreference('home:new-agent')?.modelId).toBe('cursor:composer-2.5');
    expect(loadModelPreference()?.modelId).toBe('anthropic:claude-haiku-4');

    view.unmount();
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);
    expect(await screen.findByRole('button', { name: /composer 2.5/i })).toBeInTheDocument();
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
      undefined,
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

  it('clears staged images and tokens when the catalog auto-resolves to a text-only model', async () => {
    saveModelPreference({ modelId: 'google:gemini', providerId: 'pi' });
    const view = render(
      <HomeView sessionCount={0} onSubmit={vi.fn()} providers={PI_MIXED_IMAGE_PROVIDERS} />,
    );

    expect(await screen.findByRole('button', { name: /attach image/i })).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText(/ask nuncio/i), 'inspect this');
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await userEvent.upload(fileInput!, new File(['png'], 'sample.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByTestId('attachment-tray')).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/ask nuncio/i)).toHaveValue('inspect this [image 1]');

    view.rerender(
      <HomeView sessionCount={0} onSubmit={vi.fn()} providers={PI_ONLY_PROVIDERS} />,
    );

    await waitFor(() =>
      expect(screen.getByPlaceholderText(/ask nuncio/i)).toHaveValue('inspect this'),
    );
    view.rerender(
      <HomeView sessionCount={0} onSubmit={vi.fn()} providers={PI_MIXED_IMAGE_PROVIDERS} />,
    );
    expect(await screen.findByRole('button', { name: /attach image/i })).toBeInTheDocument();
    expect(screen.queryByTestId('attachment-tray')).toBeNull();
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

  it('hides the mode picker when the provider advertises no modes', async () => {
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={PI_ONLY_PROVIDERS} />);
    expect(await screen.findByRole('button', { name: /haiku/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /session mode/i })).not.toBeInTheDocument();
  });

  it('selecting Debug switches the placeholder and forwards the mode on submit', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} providers={PI_WITH_MODES} />);
    const modeTrigger = await screen.findByRole('button', { name: /session mode/i });
    await userEvent.click(modeTrigger);
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /debug/i }));

    // Placeholder reflects the active mode (Debug voice).
    const textarea = screen.getByPlaceholderText(/debug and troubleshoot/i);
    await userEvent.type(textarea, 'trace the crash{Enter}');

    expect(onSubmit).toHaveBeenCalledWith(
      'trace the crash',
      'anthropic:claude-haiku-4',
      'pi',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      'debug',
      undefined,
    );
  });
});
