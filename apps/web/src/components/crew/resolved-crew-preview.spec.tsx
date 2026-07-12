import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResolvedCrewPreview } from './resolved-crew-preview';
import type { ResolvedCrewProfileDto } from '@nuncio/core/crew-api';

vi.mock('@/lib/api-base', () => ({
  withBase: (path: string) => `/m/test-machine${path}`,
}));

const resolution = {
  state: 'ready',
  snapshot: {
    bindings: {
      foreman: { provider: 'claude', model: 'fable', label: 'Fable' },
      builder: { provider: 'codex', model: 'sol', label: 'Sol' },
      reviewer: { provider: 'claude', model: 'opus', label: 'Opus' },
    },
  },
  issues: [],
} as unknown as ResolvedCrewProfileDto;

describe('ResolvedCrewPreview', () => {
  it('does not render a large empty-state card when no profile exists', () => {
    const { container } = render(
      <ResolvedCrewPreview resolution={null} loading={false} error={null} needsProject={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('presents a confident ready state with the shared roster and fixed tester slot', () => {
    render(<ResolvedCrewPreview resolution={resolution} loading={false} error={null} needsProject={false} />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    const roster = screen.getByLabelText(/crew roster/i);
    expect(roster).toHaveTextContent('Fable');
    expect(roster).toHaveTextContent('Nuncio Tester');
    expect(roster).toHaveTextContent('Opus');
    expect(screen.getByText('Ready').closest('[data-slot="crew-preview"]')).not.toHaveClass('border');
  });

  it('keeps Crew setup navigation inside the current machine base path', () => {
    render(
      <ResolvedCrewPreview
        resolution={{ ...resolution, state: 'needs_setup', issues: [] }}
        loading={false}
        error={null}
        needsProject={false}
      />,
    );

    expect(screen.getByRole('link', { name: /set up profile/i })).toHaveAttribute(
      'href',
      '/m/test-machine/settings?section=crew-profiles',
    );
  });
});
