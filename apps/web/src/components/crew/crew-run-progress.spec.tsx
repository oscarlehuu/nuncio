import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CrewRunProjection } from '@nuncio/core/crew-run-projection';
import { CrewRunProgress } from './crew-run-progress';

const steps: CrewRunProjection['steps'] = [
  { phase: 'PLAN', state: 'complete' },
  { phase: 'BUILD', state: 'complete' },
  { phase: 'VERIFY', state: 'current' },
  { phase: 'REVIEW', state: 'upcoming' },
  { phase: 'SYNTHESIZE', state: 'upcoming' },
  { phase: 'DONE', state: 'upcoming' },
];

describe('CrewRunProgress', () => {
  it('renders six phases with a distinct data-state for complete/current/upcoming', () => {
    render(<CrewRunProgress steps={steps} />);
    const items = screen.getByRole('list', { name: /crew run progress/i }).children;
    expect(items).toHaveLength(6);
    const states = Array.from(items).map((li) => li.getAttribute('data-state'));
    expect(states).toEqual(['complete', 'complete', 'current', 'upcoming', 'upcoming', 'upcoming']);
  });

  it('marks the current phase and exposes a redundant textual state cue', () => {
    render(<CrewRunProgress steps={steps} />);
    const current = screen.getByText('Verify').closest('li');
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(current).toHaveTextContent(/in progress/i);
    expect(screen.getByText('Plan').closest('li')).toHaveTextContent(/completed/i);
    expect(screen.getByText('Review').closest('li')).toHaveTextContent(/pending/i);
  });

  it.each(['failed', 'cancelled'] as const)('settles a terminal %s step without a spinner', (state) => {
    render(<CrewRunProgress steps={steps.map((step) => step.phase === 'DONE' ? { ...step, state } : { ...step, state: 'unknown' })} />);
    const done = screen.getByText('Done').closest('li');
    expect(done).toHaveAttribute('data-state', state);
    expect(done).toHaveTextContent(state);
    expect(done).not.toHaveAttribute('aria-current');
    expect(done?.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByText('Plan').closest('li')).toHaveTextContent(/completion unknown/i);
    expect(screen.getByText('Plan').closest('li')).not.toHaveTextContent(/pending/i);
  });
});
