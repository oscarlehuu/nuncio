import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CrewRosterLine } from './crew-roster-line';

describe('CrewRosterLine', () => {
  it('renders foreman, builder, the fixed Nuncio Tester slot, and reviewer in order', () => {
    render(<CrewRosterLine foreman="Fable" builder="Sol" reviewer="Opus" />);
    const text = screen.getByLabelText(/crew roster/i).textContent ?? '';
    expect(text).toContain('Fable');
    expect(text).toContain('Nuncio Tester');
    expect(text.indexOf('Fable')).toBeLessThan(text.indexOf('Sol'));
    expect(text.indexOf('Sol')).toBeLessThan(text.indexOf('Nuncio Tester'));
    expect(text.indexOf('Nuncio Tester')).toBeLessThan(text.indexOf('Opus'));
  });

  it('wraps a long touch-visible member label instead of hiding it behind ellipsis', () => {
    render(<CrewRosterLine foreman="A very long foreman label for a narrow mobile surface" builder="Builder" reviewer="Reviewer" />);
    const label = screen.getByText('A very long foreman label for a narrow mobile surface');
    expect(label.className).toMatch(/break-words/);
    expect(label.className).not.toMatch(/truncate/);
  });
});
