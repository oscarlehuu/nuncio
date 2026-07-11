import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CrewGates } from './crew-gates';
import type { CrewGateDto } from '@nuncio/core/crew-api';

const gate = (over: Partial<CrewGateDto>): CrewGateDto => ({
  kind: 'verify', status: 'passed', workspaceHead: 'a'.repeat(40), warnings: [], artifactId: null, ...over,
});

describe('CrewGates', () => {
  it('colors a passed gate with the success variant and a non-color icon cue', () => {
    const { container } = render(<CrewGates gates={[gate({ kind: 'verify', status: 'passed' })]} currentHead={'a'.repeat(40)} />);
    const badge = container.querySelector('[data-slot="badge"]')!;
    expect(badge).toHaveAttribute('data-variant', 'success');
    expect(badge.textContent).toMatch(/passed/i);
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('maps failing and changes-requested gates to error and warning variants', () => {
    const { container } = render(
      <CrewGates
        gates={[gate({ kind: 'verify', status: 'failed' }), gate({ kind: 'review', status: 'changes_requested' })]}
        currentHead={'a'.repeat(40)}
      />,
    );
    const variants = Array.from(container.querySelectorAll('[data-slot="badge"]')).map((b) => b.getAttribute('data-variant'));
    expect(variants).toContain('destructive');
    expect(variants).toContain('warning');
    expect(screen.getByText(/changes requested/i)).toBeInTheDocument();
  });

  it('shows a short head sha inline and keeps the full sha in the title', () => {
    render(<CrewGates gates={[gate({ status: 'passed', workspaceHead: 'a'.repeat(40) })]} currentHead={'a'.repeat(40)} />);
    expect(screen.queryByText('HEAD ' + 'a'.repeat(40))).toBeNull();
    const short = screen.getByText(/HEAD [0-9a-f]{7}$/i);
    expect(short).toHaveAttribute('title', 'a'.repeat(40));
  });
});
