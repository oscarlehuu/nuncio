import { useState } from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
          id: 'codex:gpt-5.6-sol',
          name: 'GPT-5.6 Sol',
          options: [
            { id: 'fast', label: 'Priority', type: 'boolean', defaultValue: false },
            {
              id: 'reasoningEffort',
              label: 'Reasoning',
              type: 'select',
              options: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium', isDefault: true },
                { id: 'high', label: 'High' },
                { id: 'xhigh', label: 'Extra High' },
                { id: 'max', label: 'Max' },
                { id: 'ultra', label: 'Ultra · Multi-agent' },
              ],
              defaultValue: 'medium',
            },
          ],
        },
      ],
    },
  ],
};

const MANY_MODEL_PROVIDER: ModelProvider = {
  id: 'claude',
  name: 'Claude',
  groups: [
    {
      id: 'claude',
      name: 'Claude',
      models: Array.from({ length: 8 }, (_, i) => ({
        id: `claude:model-${i + 1}`,
        name: `Claude Model ${i + 1}`,
      })),
    },
  ],
};

describe('ModelPicker', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('lists the last used models in a Recent section and records selections', async () => {
    localStorage.setItem(
      'nuncio-model-recents',
      JSON.stringify([
        { modelId: 'cursor:claude-opus-4-8', providerId: 'cursor' },
        { modelId: 'ghost:not-in-catalog', providerId: 'ghost' },
      ]),
    );
    const onChange = vi.fn();
    render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={onChange}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude haiku 4\.5/i }));

    // Known recents render on top; unknown (removed) models are skipped silently.
    const recentLabel = await screen.findByText('Recent');
    expect(recentLabel).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem', { name: /claude opus 4 8/i }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/not-in-catalog/)).not.toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('menuitem', { name: /claude haiku 4\.5/i })[0]);
    const stored = JSON.parse(localStorage.getItem('nuncio-model-recents') ?? '[]');
    expect(stored[0]).toEqual({ modelId: 'anthropic:claude-haiku-4-5', providerId: 'pi' });
  });

  it('collapses a large provider to featured models plus an expander row', async () => {
    render(
      <ModelPicker
        value="claude:model-1"
        onChange={vi.fn()}
        providers={[MANY_MODEL_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude model 1/i }));

    expect(await screen.findByRole('menuitem', { name: /claude model 3/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /claude model 7/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('menuitem', { name: /show all 8 claude models/i }));
    expect(await screen.findByRole('menuitem', { name: /claude model 7/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /show all 8 claude models/i })).not.toBeInTheDocument();
  });

  it('keeps the active model visible when its provider is collapsed', async () => {
    render(
      <ModelPicker
        value="claude:model-8"
        onChange={vi.fn()}
        providers={[MANY_MODEL_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude model 8/i }));

    expect(await screen.findByRole('menuitem', { name: /claude model 8/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /claude model 5/i })).not.toBeInTheDocument();
  });

  it('searching disables the featured collapse', async () => {
    render(
      <ModelPicker
        value="claude:model-1"
        onChange={vi.fn()}
        providers={[MANY_MODEL_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude model 1/i }));
    await userEvent.type(await screen.findByPlaceholderText(/search models/i), 'model');

    expect(await screen.findByRole('menuitem', { name: /claude model 7/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /show all 8 claude models/i })).not.toBeInTheDocument();
  });

  it('filters to one CLI via icon chips and shows its full catalog', async () => {
    render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={vi.fn()}
        providers={[PI_PROVIDER, MANY_MODEL_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude haiku 4\.5/i }));

    const chipRow = await screen.findByRole('group', { name: /filter by cli/i });
    expect(chipRow).toBeInTheDocument();
    // Chips are icon-only — accessible name is the provider (or All), not visible text labels.
    expect(within(chipRow).queryByText(/^Pi$/i)).not.toBeInTheDocument();
    expect(within(chipRow).queryByText(/^Claude$/i)).not.toBeInTheDocument();
    await userEvent.click(within(chipRow).getByRole('button', { name: /^claude$/i }));

    // Filtered to the Claude CLI: Pi's models leave, and the collapse is off.
    expect(screen.queryByRole('menuitem', { name: /claude haiku 4\.5/i })).not.toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: /claude model 7/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /show all 8 claude models/i })).not.toBeInTheDocument();

    await userEvent.click(within(chipRow).getByRole('button', { name: /^all$/i }));
    expect(await screen.findByRole('menuitem', { name: /claude haiku 4\.5/i })).toBeInTheDocument();
  });

  it('docks reasoning and priority controls in a sticky footer, not mid-list', async () => {
    render(
      <ModelPicker
        value="codex:gpt-5.6-sol"
        modelOptions={{ fast: false, reasoningEffort: 'medium' }}
        onChange={vi.fn()}
        providers={[CODEX_PROVIDER, PI_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /gpt-5\.6 sol/i }));

    const footer = await screen.findByTestId('model-picker-options-footer');
    expect(within(footer).getByRole('slider', { name: /reasoning effort/i })).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: /turn on fast mode/i })).toBeInTheDocument();

    const gptRow = screen.getByRole('menuitem', { name: /gpt-5\.6 sol/i });
    expect(within(gptRow).queryByRole('slider')).not.toBeInTheDocument();
    // List rows after the selected model stay siblings — no options card nested between them.
    expect(gptRow.parentElement?.querySelector('[data-testid="model-picker-options-footer"]')).toBeNull();
  });

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

  it('selects composer from the flat model panel with fast=false', async () => {
    const onChange = vi.fn();
    render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={onChange}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude haiku 4\.5/i }));
    expect(await screen.findByPlaceholderText(/search models/i)).toBeInTheDocument();
    expect(screen.getAllByText('Pi').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Cursor').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('model-picker-provider-submenu')).not.toBeInTheDocument();
    const composer = await screen.findByRole('menuitem', { name: /composer 2\.5/i });
    await userEvent.click(composer);

    expect(onChange).toHaveBeenCalledWith('cursor:composer-2.5', 'cursor', { fast: false });
  });

  it('toggles fast via the lightning control in the sticky options footer', async () => {
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
    expect(await screen.findByRole('menuitem', { name: /composer 2\.5/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /turn on fast mode/i }));

    expect(onChange).toHaveBeenCalledWith('cursor:composer-2.5', 'cursor', { fast: true });
    expect(screen.getByRole('button', { name: /turn off fast mode/i })).toBeInTheDocument();
  });

  it('renders GPT-5.6 Ultra as the final reasoning slider choice and Priority as fast', async () => {
    const onChange = vi.fn();
    render(
      <ModelPicker
        value="codex:gpt-5.6-sol"
        modelOptions={{ fast: false, reasoningEffort: 'medium' }}
        onChange={onChange}
        providers={[CODEX_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /gpt-5\.6 sol/i }));

    expect(screen.getByRole('slider', { name: /reasoning effort/i })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: /reasoning effort/i })).toHaveAttribute('aria-valuemax', '5');
    expect(screen.queryByRole('menuitem', { name: /^ultra/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('slider', { name: /reasoning effort/i }), {
      target: { value: '5' },
    });
    expect(onChange).toHaveBeenCalledWith('codex:gpt-5.6-sol', 'codex', {
      fast: false,
      reasoningEffort: 'ultra',
    });

    await userEvent.click(screen.getByRole('button', { name: /turn on fast mode/i }));
    expect(onChange).toHaveBeenLastCalledWith('codex:gpt-5.6-sol', 'codex', {
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

    expect(screen.queryByRole('menuitem', { name: /^fast$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /turn on fast mode/i })).not.toBeInTheDocument();
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

    // Section headers keep provider names; filter chips are icons (aria-label only).
    const headers = await screen.findAllByText('Pi');
    const cursorHeaders = await screen.findAllByText('Cursor');
    expect(headers.length).toBeGreaterThan(0);
    expect(cursorHeaders.length).toBeGreaterThan(0);
    expect(
      headers[0].compareDocumentPosition(cursorHeaders[0]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    expect(await screen.findByRole('menuitem', { name: /pi provider default/i })).toBeInTheDocument();
    expect(screen.queryByTestId('model-picker-provider-submenu')).not.toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole('menuitem', { name: /cursor provider default/i }));

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
    await userEvent.click(await screen.findByRole('menuitem', { name: /claude haiku 4\.5/i }));

    expect(onPairChange).toHaveBeenCalledWith('pi', 'anthropic:claude-haiku-4-5');
  });

  it('renders pair mode as one phone-safe flat panel with internal scroll', async () => {
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

    const panel = await screen.findByTestId('model-picker-flat-panel');
    expect(panel).toHaveClass('max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))]');
    expect(panel.getAttribute('style')).toContain('min-width: min(22rem, calc(100vw - 24px))');
    expect(screen.getByTestId('model-picker-list')).toHaveClass('overflow-y-auto');
    expect(screen.getByPlaceholderText(/search models/i)).toBeInTheDocument();
    expect(screen.queryByTestId('model-picker-provider-submenu')).not.toBeInTheDocument();
  });

  it('renders a fixed-width fast slot in every model row so names align', async () => {
    render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={vi.fn()}
        providers={[PI_PROVIDER, CURSOR_PROVIDER, CODEX_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude haiku 4\.5/i }));
    await screen.findByTestId('model-picker-flat-panel');

    // Every model row (plain, configurable, variant) carries the slot.
    const rows = screen.getAllByRole('menuitem');
    for (const row of rows) {
      expect(within(row).getByTestId('model-fast-slot')).toBeInTheDocument();
    }
    // Fast-capable rows show the bolt; the rest render the equal-width spacer.
    const gpt = screen.getByRole('menuitem', { name: /gpt-5\.6 sol/i });
    expect(within(gpt).getByTestId('model-fast-slot')).toHaveAttribute('data-fast', 'true');
    const haiku = screen.getAllByRole('menuitem', { name: /claude haiku 4\.5/i })[0];
    expect(within(haiku).getByTestId('model-fast-slot')).toHaveAttribute('data-fast', 'false');
  });

  it('pair mode reuses the rich panel: chips, collapse, fast slots, no recents', async () => {
    localStorage.setItem(
      'nuncio-model-recents',
      JSON.stringify([{ modelId: 'anthropic:claude-haiku-4-5', providerId: 'pi' }]),
    );
    const onPairChange = vi.fn();
    render(
      <ModelPicker
        pairMode="engine+model"
        engine="claude"
        model="claude:model-8"
        onPairChange={onPairChange}
        providers={[MANY_MODEL_PROVIDER, CODEX_PROVIDER]}
        inheritOption={{ label: 'Inherit from project' }}
        providerDefaultOption
        autoPick={false}
        variant="text"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /engine and model/i }));

    // Same renderer as chat mode: chips row and featured collapse.
    expect(await screen.findByRole('group', { name: /filter by cli/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /show all 8 claude models/i })).toBeInTheDocument();
    // The selected engine+model survives its provider's collapse.
    expect(screen.getByRole('menuitem', { name: /claude model 8/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /claude model 5/i })).not.toBeInTheDocument();
    // Fast slots align pair rows too.
    const gpt = screen.getByRole('menuitem', { name: /gpt-5\.6 sol/i });
    expect(within(gpt).getByTestId('model-fast-slot')).toHaveAttribute('data-fast', 'true');
    // Pair mode never shows or records recents.
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /gpt-5\.6 sol/i }));
    expect(onPairChange).toHaveBeenCalledWith('codex', 'codex:gpt-5.6-sol');
    const stored = JSON.parse(localStorage.getItem('nuncio-model-recents') ?? '[]');
    expect(stored).toEqual([{ modelId: 'anthropic:claude-haiku-4-5', providerId: 'pi' }]);
  });

  it('keeps chat model picking in the same flat panel', async () => {
    render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={vi.fn()}
        providers={[PI_PROVIDER, CURSOR_PROVIDER]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /claude haiku 4\.5/i }));

    const panel = await screen.findByTestId('model-picker-flat-panel');
    expect(panel).toHaveClass('max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))]');
    expect(screen.getByTestId('model-picker-list')).toHaveClass('overflow-y-auto');
    expect(screen.getByPlaceholderText(/search models/i)).toBeInTheDocument();
    expect(screen.queryByTestId('model-picker-provider-submenu')).not.toBeInTheDocument();
  });

  it('uses the same compact trigger grammar for chat and engine-model modes', () => {
    const { unmount } = render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={vi.fn()}
        providers={[PI_PROVIDER]}
        variant="text"
        compact
      />,
    );

    const chatTrigger = screen.getByRole('button', { name: /claude haiku 4\.5/i });
    expect(chatTrigger).toHaveAttribute('data-slot', 'model-picker-trigger');
    expect(chatTrigger).toHaveAttribute('data-density', 'compact');
    unmount();

    render(
      <ModelPicker
        pairMode="engine+model"
        engine="pi"
        model="anthropic:claude-haiku-4-5"
        onPairChange={vi.fn()}
        providers={[PI_PROVIDER]}
        variant="text"
        compact
      />,
    );

    const pairTrigger = screen.getByRole('button', { name: /engine and model: pi · claude haiku 4\.5/i });
    expect(pairTrigger).toHaveAttribute('data-slot', 'model-picker-trigger');
    expect(pairTrigger).toHaveAttribute('data-density', 'compact');
  });

  it('uses compact height instead of retaining the boxed default height', () => {
    render(
      <ModelPicker
        value="anthropic:claude-haiku-4-5"
        onChange={vi.fn()}
        providers={[PI_PROVIDER]}
        variant="boxed"
        compact
      />,
    );

    const trigger = screen.getByRole('button', { name: /claude haiku 4\.5/i });
    expect(trigger).toHaveClass('h-7');
    expect(trigger).not.toHaveClass('h-8');
  });
});
