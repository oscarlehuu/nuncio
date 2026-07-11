import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResolvedCrewPreview } from './resolved-crew-preview';
import type { ResolvedCrewProfileDto } from '@nuncio/core/crew-api';

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
  it('presents a confident ready state with the shared roster and fixed tester slot', () => {
    render(<ResolvedCrewPreview resolution={resolution} loading={false} error={null} needsProject={false} />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    const roster = screen.getByLabelText(/crew roster/i);
    expect(roster).toHaveTextContent('Fable');
    expect(roster).toHaveTextContent('Nuncio Tester');
    expect(roster).toHaveTextContent('Opus');
  });
});
