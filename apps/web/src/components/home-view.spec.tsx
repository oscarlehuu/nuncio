import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeView } from './home-view';
import { saveModelPreference } from '../lib/model-preference';
import {
  recordBranchSelection,
  recordProjectSelection,
} from '../lib/project-preference';
import type { ModelProvider } from '../lib/model-providers';

const PI_ONLY_PROVIDERS: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Pi',
    groups: [{ id: 'g', name: 'G', models: [{ id: 'anthropic:claude-haiku-4', name: 'Haiku' }] }],
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

vi.mock('./branch-picker', () => ({
  BranchPicker: ({
    value,
    onChange,
  }: {
    value?: string;
    onChange: (branch: string) => void;
  }) => (
    <button type="button" onClick={() => onChange('main')}>
      {value ?? 'Branch'}
    </button>
  ),
}));

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

  it('does not submit on Enter when the prompt is empty', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} providers={CURSOR_AND_PI} />);
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /send/i })).toBeNull();
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

  it('shows the session count badge', () => {
    render(<HomeView sessionCount={3} onSubmit={vi.fn()} />);
    expect(screen.getByText(/3 sessions/i)).toBeInTheDocument();
  });

  it('shows a live-status badge per available provider', () => {
    const providers = [
      { id: 'pi', name: 'Pi', groups: [] },
      { id: 'cursor', name: 'Cursor', groups: [] },
      { id: 'anthropic-direct', name: 'Anthropic', unavailable: true, groups: [] },
    ];
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={providers} />);
    expect(screen.getByLabelText(/pi connected/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/cursor connected/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/anthropic connected/i)).toBeNull();
    expect(screen.getByText('Pi')).toBeInTheDocument();
    expect(screen.getByText('Cursor')).toBeInTheDocument();
    expect(screen.queryByText(/connected$/i)).toBeNull();
  });

  it('does not show provider badges before the live catalog loads', () => {
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={[]} />);
    expect(screen.queryByLabelText(/connected/i)).toBeNull();
  });

  it('stacks textarea above a single-row scrolling picker toolbar', () => {
    const { container } = render(<HomeView sessionCount={0} onSubmit={vi.fn()} />);
    const card = container.querySelector('.home-composer');
    const bar = container.querySelector('.home-composer-bar');
    const pickers = container.querySelector('.home-composer-pickers');

    expect(card).toHaveClass('flex', 'flex-col');
    expect(bar).toHaveClass('border-t');
    expect(pickers).toBeTruthy();
    expect(pickers).toHaveClass('overflow-x-auto');
    expect(pickers).not.toHaveClass('flex-wrap');
  });

  it('forwards project and branch selections on submit', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} providers={CURSOR_AND_PI} />);
    await userEvent.click(screen.getByRole('button', { name: /no repo/i }));
    await userEvent.click(screen.getByRole('button', { name: /^branch$/i }));
    await userEvent.type(screen.getByPlaceholderText(/ask nuncio/i), 'Add workspace{Enter}');
    expect(onSubmit).toHaveBeenCalledWith(
      'Add workspace',
      'cursor:composer-2.5',
      'cursor',
      '/code/nuncio',
      'main',
      undefined,
    );
  });

  it('restores the last project and branch from localStorage', () => {
    recordProjectSelection('/code/nuncio', 'nuncio');
    recordBranchSelection('/code/nuncio', 'develop');
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={CURSOR_AND_PI} />);
    expect(screen.getByRole('button', { name: /^nuncio$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^develop$/i })).toBeInTheDocument();
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
    );
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
});
