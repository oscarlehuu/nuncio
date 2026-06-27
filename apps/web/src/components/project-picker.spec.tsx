import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectPicker } from './project-picker';

const mockFetchProjects = vi.fn();

vi.mock('../lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/projects')>();
  return {
    ...actual,
    fetchProjects: (...args: unknown[]) => mockFetchProjects(...args),
  };
});

describe('ProjectPicker', () => {
  beforeEach(() => {
    mockFetchProjects.mockResolvedValue([
      { id: '/code/nuncio', name: 'nuncio', path: '/code/nuncio', isGit: true },
    ]);
  });

  it('lists projects and selects one', async () => {
    const onChange = vi.fn();
    render(<ProjectPicker onChange={onChange} />);

    await userEvent.click(await screen.findByRole('button', { name: /no repo/i }));
    await userEvent.click(await screen.findByRole('option', { name: /nuncio/i }));

    expect(onChange).toHaveBeenCalledWith('/code/nuncio');
  });

  it('supports entering a custom path', async () => {
    const onChange = vi.fn();
    render(<ProjectPicker onChange={onChange} />);

    await userEvent.click(await screen.findByRole('button', { name: /no repo/i }));
    await userEvent.click(await screen.findByRole('option', { name: /custom path/i }));

    const input = await screen.findByLabelText(/custom project path/i);
    await userEvent.type(input, '/Users/dev/custom-repo');
    await userEvent.click(screen.getByRole('button', { name: /use path/i }));

    expect(onChange).toHaveBeenCalledWith('/Users/dev/custom-repo');
  });
});
