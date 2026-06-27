import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelPicker } from './model-picker';

vi.mock('../lib/api', () => ({
  fetchModels: vi.fn().mockResolvedValue([
    {
      id: 'pi',
      name: 'Pi',
      groups: [
        {
          id: 'g1',
          name: 'Cliproxy',
          models: [
            { id: 'm1', name: 'Model One', sub: 'first' },
            { id: 'm2', name: 'Model Two', sub: 'second' },
          ],
        },
      ],
    },
  ]),
}));

describe('ModelPicker', () => {
  it('opens, filters by search, and selects a model', async () => {
    const onChange = vi.fn();
    render(<ModelPicker value="m2" onChange={onChange} />);

    const trigger = await screen.findByRole('button', { name: /model two/i });
    await userEvent.click(trigger);

    const input = await screen.findByPlaceholderText(/search models/i);
    await userEvent.type(input, 'Model One');

    await userEvent.click(screen.getByRole('option', { name: /model one/i }));
    expect(onChange).toHaveBeenCalledWith('m1', 'pi');
  });
});
