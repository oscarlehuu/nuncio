import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CrewProfileDto } from '@nuncio/core/crew-api';
import { CrewProfilePicker } from './crew-profile-picker';

vi.mock('@/lib/api-base', () => ({
  withBase: (path: string) => `/m/test-machine${path}`,
}));

const profiles = [
  { id: 'quality', name: 'Quality Crew' },
  { id: 'release', name: 'Release Crew' },
] as CrewProfileDto[];

describe('CrewProfilePicker', () => {
  it('uses a compact inline menu and selects another profile', async () => {
    const onChange = vi.fn();
    render(
      <CrewProfilePicker
        profiles={profiles}
        value="quality"
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole('button', { name: /crew profile: quality crew/i });
    expect(trigger).toHaveClass('h-7');
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('menuitemradio', { name: /release crew/i }));
    expect(onChange).toHaveBeenCalledWith('release');
  });

  it('replaces the empty select with a small settings action', () => {
    render(
      <CrewProfilePicker
        profiles={[]}
        value=""
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('link', { name: /set up crew/i })).toHaveAttribute(
      'href',
      '/m/test-machine/settings?section=crew-profiles',
    );
  });
});
