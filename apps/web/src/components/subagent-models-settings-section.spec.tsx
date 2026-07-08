import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubagentModelsSettingsSection } from './subagent-models-settings-section';
import { fetchModels } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, fetchModels: vi.fn() };
});

const PROVIDERS: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Pi',
    groups: [
      {
        id: 'g',
        name: 'g',
        models: [
          { id: 'claude-fable-5', name: 'Fable 5' },
          { id: 'claude-opus-4-8', name: 'Opus 4.8' },
        ],
      },
    ],
  },
];

describe('SubagentModelsSettingsSection', () => {
  it('serializes a per-provider selection into the NUNCIO_SUBAGENT_MODELS JSON map', async () => {
    vi.mocked(fetchModels).mockResolvedValue(PROVIDERS);
    const onUpdate = vi.fn(async () => {});
    render(<SubagentModelsSettingsSection value={null} onUpdate={onUpdate} />);

    // Row per provider appears once models load.
    await screen.findByText('Pi');
    // Open the borderless picker (its label starts as "Select model" while unset),
    // hover the provider submenu, then choose a model.
    await userEvent.click(screen.getByRole('button', { name: /select model/i }));
    const piSubmenu = await screen.findByRole('menuitem', { name: /^pi$/i });
    await userEvent.hover(piSubmenu);
    await userEvent.click(await screen.findByRole('menuitem', { name: /opus 4\.8/i }));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith('NUNCIO_SUBAGENT_MODELS', '{"pi":"claude-opus-4-8"}'),
    );
  });

  it('hydrates the picker from the stored map value', async () => {
    vi.mocked(fetchModels).mockResolvedValue(PROVIDERS);
    render(
      <SubagentModelsSettingsSection value='{"pi":"claude-fable-5"}' onUpdate={vi.fn(async () => {})} />,
    );
    // The trigger reflects the stored model, not the "Select model" placeholder.
    expect(await screen.findByRole('button', { name: /fable 5/i })).toBeInTheDocument();
  });

  it('clears a provider override, unsetting the whole map when it was the only one', async () => {
    vi.mocked(fetchModels).mockResolvedValue(PROVIDERS);
    const onUpdate = vi.fn(async () => {});
    render(
      <SubagentModelsSettingsSection value='{"pi":"claude-fable-5"}' onUpdate={onUpdate} />,
    );

    // The clear affordance only appears once an override is set.
    const clear = await screen.findByRole('button', { name: /clear pi subagent model/i });
    await userEvent.click(clear);

    // Empty map serializes to '' — the setting reads as unset.
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('NUNCIO_SUBAGENT_MODELS', ''));
  });

  it('has no clear affordance when a provider has no override', async () => {
    vi.mocked(fetchModels).mockResolvedValue(PROVIDERS);
    render(<SubagentModelsSettingsSection value={null} onUpdate={vi.fn(async () => {})} />);
    await screen.findByText('Pi');
    expect(screen.queryByRole('button', { name: /clear pi subagent model/i })).toBeNull();
  });
});
