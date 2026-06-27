import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelPicker } from './model-picker';
import type { ModelProvider } from '../lib/model-providers';

const PI_PROVIDER: ModelProvider = {
  id: 'pi',
  name: 'Pi',
  groups: [
    {
      id: 'g1',
      name: 'Cliproxy',
      models: [
        { id: 'anthropic:claude-haiku-4-5', name: 'Claude Haiku 4.5 (latest)' },
        { id: 'anthropic:claude-opus-4-8', name: 'Claude Opus 4.8' },
      ],
    },
  ],
};

const CURSOR_PROVIDER: ModelProvider = {
  id: 'cursor',
  name: 'Cursor',
  groups: [
    {
      id: 'cursor',
      name: 'Cursor',
      models: [
        { id: 'cursor:composer-2.5', name: 'composer-2.5' },
        { id: 'cursor:claude-opus-4-8', name: 'claude-opus-4-8' },
      ],
    },
  ],
};

describe('ModelPicker', () => {
  it('shows the pretty model name on the trigger', async () => {
    render(
      <ModelPicker
        value="cursor:composer-2.5"
        onChange={vi.fn()}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
      />,
    );
    expect(screen.getByRole('button', { name: /composer 2\.5/i })).toBeInTheDocument();
  });

  it('drills engine → model and fires onChange with cursor providerId', async () => {
    const onChange = vi.fn();
    render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={onChange}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude haiku 4\.5/i }));

    const cursorEngine = await screen.findByRole('menuitem', { name: /cursor/i });
    await userEvent.hover(cursorEngine);

    const model = await screen.findByRole('menuitemradio', { name: /composer 2\.5/i });
    await userEvent.click(model);

    expect(onChange).toHaveBeenCalledWith('cursor:composer-2.5', 'cursor');
  });

  it('lists cursor before pi in the engine menu', async () => {
    render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={vi.fn()}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude haiku 4\.5/i }));

    const engines = await screen.findAllByRole('menuitem', { name: /^(cursor|pi)$/i });
    expect(engines[0]).toHaveAccessibleName(/cursor/i);
    expect(engines[1]).toHaveAccessibleName(/pi/i);
  });

  it('prettifies cursor model names inside the engine submenu', async () => {
    render(
      <ModelPicker
        value="cursor:composer-2.5"
        onChange={vi.fn()}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /composer 2\.5/i }));
    const cursorEngine = await screen.findByRole('menuitem', { name: /cursor/i });
    await userEvent.hover(cursorEngine);

    expect(await screen.findByRole('menuitemradio', { name: /composer 2\.5/i })).toBeInTheDocument();
    expect(await screen.findByRole('menuitemradio', { name: /claude opus 4 8/i })).toBeInTheDocument();
  });
});
