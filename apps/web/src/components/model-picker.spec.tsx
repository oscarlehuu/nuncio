import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelPicker } from './model-picker';
import type { ModelProvider } from '../lib/model-providers';
import type { ModelOptionsMap } from '../lib/model-options';

const PI_PROVIDER: ModelProvider = {
  id: 'pi',
  name: 'Pi',
  groups: [
    {
      id: 'g1',
      name: 'Anthropic',
      models: [
        { id: 'anthropic:claude-haiku-4-5', name: 'Claude Haiku 4.5 (latest)' },
        {
          id: 'anthropic:claude-opus-4-6',
          name: 'Claude Opus 4.6',
          options: [
            {
              id: 'thinkingLevel',
              label: 'Thinking',
              type: 'select',
              options: [
                { id: 'medium', label: 'Medium', isDefault: true },
                { id: 'high', label: 'High' },
              ],
              defaultValue: 'medium',
            },
          ],
        },
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
        {
          id: 'cursor:composer-2.5',
          name: 'Composer 2.5',
          options: [{ id: 'fast', label: 'Fast', type: 'boolean', defaultValue: false }],
          variants: [{ label: 'Composer 2.5 Fast', params: [{ id: 'fast', value: 'true' }] }],
        },
        { id: 'cursor:claude-opus-4-8', name: 'claude-opus-4-8' },
      ],
    },
  ],
};

const CODEX_PROVIDER: ModelProvider = {
  id: 'codex',
  name: 'Codex',
  groups: [
    {
      id: 'openai',
      name: 'OpenAI',
      models: [
        {
          id: 'codex:gpt-5.5',
          name: 'GPT-5.5',
          options: [
            { id: 'fast', label: 'Priority', type: 'boolean', defaultValue: false },
            {
              id: 'reasoningEffort',
              label: 'Reasoning',
              type: 'select',
              options: [
                { id: 'medium', label: 'Medium', isDefault: true },
                { id: 'xhigh', label: 'Xhigh' },
              ],
              defaultValue: 'medium',
            },
          ],
        },
      ],
    },
  ],
};

describe('ModelPicker', () => {
  it('shows a green lightning indicator when fast is on', () => {
    render(
      <ModelPicker
        value="cursor:composer-2.5"
        modelOptions={{ fast: true }}
        onChange={vi.fn()}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
      />,
    );
    expect(screen.getByRole('button', { name: /composer 2\.5 fast/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Fast mode on')).toBeInTheDocument();
  });

  it('selects composer via submenu with fast=false', async () => {
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

    const composer = await screen.findByRole('menuitem', { name: /composer 2\.5/i });
    await userEvent.click(composer);

    expect(onChange).toHaveBeenCalledWith('cursor:composer-2.5', 'cursor', { fast: false });
  });

  it('toggles fast via the lightning control in the options panel', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [opts, setOpts] = useState<ModelOptionsMap>({ fast: false });
      return (
        <ModelPicker
          value="cursor:composer-2.5"
          modelOptions={opts}
          onChange={(modelId, providerId, next) => {
            onChange(modelId, providerId, next);
            if (next) setOpts(next);
          }}
          providers={[CURSOR_PROVIDER]}
        />
      );
    }
    render(<Harness />);

    await userEvent.click(screen.getByRole('button', { name: /composer 2\.5/i }));
    const cursorEngine = await screen.findByRole('menuitem', { name: /cursor/i });
    await userEvent.hover(cursorEngine);

    const composer = await screen.findByRole('menuitem', { name: /composer 2\.5/i });
    await userEvent.click(composer);

    await userEvent.click(screen.getByRole('button', { name: /turn on fast mode/i }));

    expect(onChange).toHaveBeenCalledWith('cursor:composer-2.5', 'cursor', { fast: true });
    expect(screen.getByRole('button', { name: /turn off fast mode/i })).toBeInTheDocument();
  });

  it('renders Codex reasoning effort as a slider and Priority as fast', async () => {
    const onChange = vi.fn();
    render(
      <ModelPicker
        value="codex:gpt-5.5"
        modelOptions={{ fast: false, reasoningEffort: 'medium' }}
        onChange={onChange}
        providers={[CODEX_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /gpt 5\.5/i }));
    const codexEngine = await screen.findByRole('menuitem', { name: /codex/i });
    await userEvent.hover(codexEngine);

    const codex = await screen.findByRole('menuitem', { name: /gpt 5\.5/i });
    await userEvent.click(codex);

    expect(screen.getByRole('slider', { name: /reasoning effort/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^xhigh$/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('slider', { name: /reasoning effort/i }), {
      target: { value: '1' },
    });
    expect(onChange).toHaveBeenCalledWith('codex:gpt-5.5', 'codex', {
      fast: false,
      reasoningEffort: 'xhigh',
    });

    await userEvent.click(screen.getByRole('button', { name: /turn on fast mode/i }));
    expect(onChange).toHaveBeenLastCalledWith('codex:gpt-5.5', 'codex', {
      fast: true,
      reasoningEffort: 'medium',
    });
  });

  it('does not show fast options for models without fast support', async () => {
    render(
      <ModelPicker
        value="cursor:claude-opus-4-8"
        onChange={vi.fn()}
        providers={[CURSOR_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude opus 4 8/i }));
    const cursorEngine = await screen.findByRole('menuitem', { name: /cursor/i });
    await userEvent.hover(cursorEngine);

    expect(screen.queryByRole('menuitem', { name: /^fast$/i })).not.toBeInTheDocument();
  });

  it('drops fast when switching to a model that does not support it', async () => {
    const onChange = vi.fn();
    render(
      <ModelPicker
        value="cursor:composer-2.5"
        modelOptions={{ fast: true }}
        onChange={onChange}
        providers={[CURSOR_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /composer 2\.5/i }));
    const cursorEngine = await screen.findByRole('menuitem', { name: /cursor/i });
    await userEvent.hover(cursorEngine);

    const opus = await screen.findByRole('menuitem', { name: /claude opus 4 8/i });
    await userEvent.click(opus);

    expect(onChange).toHaveBeenCalledWith('cursor:claude-opus-4-8', 'cursor', undefined);
  });

  it('opens a thinking effort slider for pi reasoning models', async () => {
    const onChange = vi.fn();
    render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={onChange}
        providers={[PI_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude haiku 4\.5/i }));
    const piEngine = await screen.findByRole('menuitem', { name: /^pi$/i });
    await userEvent.hover(piEngine);

    const opusRow = await screen.findByRole('menuitem', { name: /claude opus 4\.6/i });
    await userEvent.click(opusRow);

    expect(screen.getByRole('slider', { name: /thinking effort/i })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider', { name: /thinking effort/i }), {
      target: { value: '1' },
    });

    expect(onChange).toHaveBeenCalledWith('anthropic:claude-opus-4-6', 'pi', {
      thinkingLevel: 'high',
    });
    expect(screen.queryByRole('slider', { name: /thinking effort/i })).toBeInTheDocument();
  });

  it('lists pi before cursor in the engine menu', async () => {
    render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={vi.fn()}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude haiku 4\.5/i }));

    const engines = await screen.findAllByRole('menuitem', { name: /^(cursor|pi)$/i });
    expect(engines[0]).toHaveAccessibleName(/pi/i);
    expect(engines[1]).toHaveAccessibleName(/cursor/i);
  });

  it('shows a header per group when pi has more than one group', async () => {
    const multiGroupPi: ModelProvider = {
      id: 'pi',
      name: 'Pi',
      groups: [
        {
          id: 'g1',
          name: 'Anthropic',
          models: [{ id: 'anthropic:claude-haiku-4-5', name: 'Claude Haiku 4.5 (latest)' }],
        },
        {
          id: 'g2',
          name: 'OpenAI',
          models: [{ id: 'codex:gpt-5.5', name: 'GPT-5.5' }],
        },
      ],
    };

    render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={vi.fn()}
        providers={[multiGroupPi]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude haiku 4\.5/i }));
    const piEngine = await screen.findByRole('menuitem', { name: /^pi$/i });
    await userEvent.hover(piEngine);

    expect(await screen.findByText('Anthropic')).toBeInTheDocument();
    expect(await screen.findByText('OpenAI')).toBeInTheDocument();
  });

  it('renders pair-mode inherit and provider-default rows', async () => {
    const onPairChange = vi.fn();
    render(
      <ModelPicker
        pairMode="engine+model"
        engine={null}
        model={null}
        onPairChange={onPairChange}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
        inheritOption={{ label: 'Inherit from project' }}
        providerDefaultOption
        autoPick={false}
        variant="text"
      />,
    );

    await userEvent.click(
      screen.getByRole('button', { name: /engine and model: inherit from project · default model/i }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: /inherit from project/i }));
    expect(onPairChange).toHaveBeenCalledWith(null, null);

    await userEvent.click(
      screen.getByRole('button', { name: /engine and model: inherit from project · default model/i }),
    );
    const piEngine = await screen.findByRole('menuitem', { name: /^pi$/i });
    await userEvent.hover(piEngine);
    expect(await screen.findByRole('menuitem', { name: /provider default/i })).toBeInTheDocument();
  });

  it('resets the pair-mode model when selecting an engine provider default', async () => {
    const onPairChange = vi.fn();
    render(
      <ModelPicker
        pairMode="engine+model"
        engine="pi"
        model="anthropic:claude-haiku-4-5"
        onPairChange={onPairChange}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
        inheritOption={{ label: 'Inherit from project' }}
        providerDefaultOption
        autoPick={false}
        variant="text"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /engine and model: pi · claude haiku 4\.5/i }));
    const cursorEngine = await screen.findByRole('menuitem', { name: /^cursor$/i });
    await userEvent.hover(cursorEngine);
    await userEvent.click(await screen.findByRole('menuitem', { name: /provider default/i }));

    expect(onPairChange).toHaveBeenCalledWith('cursor', null);
  });

  it('does not auto-pick an unknown pair-mode model when autoPick is disabled', () => {
    const onPairChange = vi.fn();
    render(
      <ModelPicker
        pairMode="engine+model"
        engine="pi"
        model="ghost-model-9"
        onPairChange={onPairChange}
        providers={[PI_PROVIDER]}
        inheritOption={{ label: 'Inherit from project' }}
        providerDefaultOption
        autoPick={false}
        variant="text"
      />,
    );

    expect(
      screen.getByRole('button', { name: /engine and model: pi · ghost-model-9/i }),
    ).toBeInTheDocument();
    expect(onPairChange).not.toHaveBeenCalled();
  });

  it('selects a concrete pair-mode model without model option payloads', async () => {
    const onPairChange = vi.fn();
    render(
      <ModelPicker
        pairMode="engine+model"
        engine={null}
        model={null}
        onPairChange={onPairChange}
        providers={[PI_PROVIDER]}
        inheritOption={{ label: 'Inherit from project' }}
        providerDefaultOption
        autoPick={false}
        variant="text"
      />,
    );

    await userEvent.click(
      screen.getByRole('button', { name: /engine and model: inherit from project · default model/i }),
    );
    const piEngine = await screen.findByRole('menuitem', { name: /^pi$/i });
    await userEvent.hover(piEngine);
    await userEvent.click(await screen.findByRole('menuitem', { name: /claude haiku 4\.5/i }));

    expect(onPairChange).toHaveBeenCalledWith('pi', 'anthropic:claude-haiku-4-5');
  });

  it('gives provider submenus a phone-safe width and Radix collision padding', async () => {
    render(
      <ModelPicker
        pairMode="engine+model"
        engine={null}
        model={null}
        onPairChange={vi.fn()}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
        inheritOption={{ label: 'Inherit from project' }}
        providerDefaultOption
        autoPick={false}
        variant="text"
      />,
    );

    await userEvent.click(
      screen.getByRole('button', { name: /engine and model: inherit from project · default model/i }),
    );
    await userEvent.hover(await screen.findByRole('menuitem', { name: /^pi$/i }));

    const submenu = await screen.findByTestId('model-picker-provider-submenu');
    expect(submenu).toHaveAttribute('data-collision-padding', '12');
    expect(submenu).toHaveAttribute('data-side-offset', '6');
    expect(submenu.getAttribute('style')).toContain('min-width: min(20rem, calc(100vw - 24px))');
    expect(submenu).toHaveClass('max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))]');
  });

  it('keeps chat model submenus on the same collision-aware sizing contract', async () => {
    render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={vi.fn()}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude haiku 4\.5/i }));
    await userEvent.hover(await screen.findByRole('menuitem', { name: /^pi$/i }));

    const submenu = await screen.findByTestId('model-picker-provider-submenu');
    expect(submenu).toHaveAttribute('data-collision-padding', '12');
    expect(submenu).toHaveAttribute('data-side-offset', '6');
    expect(submenu.getAttribute('style')).toContain('min-width: min(20rem, calc(100vw - 24px))');
  });
});
