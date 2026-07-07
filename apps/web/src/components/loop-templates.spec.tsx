import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoopTemplates, LOOP_TEMPLATES } from './loop-templates';

describe('LoopTemplates', () => {
  it('renders the curated template gallery', () => {
    render(<LoopTemplates onPick={vi.fn()} />);
    expect(screen.getByText('Nightly maintenance')).toBeInTheDocument();
    expect(screen.getByText('Add test coverage')).toBeInTheDocument();
    expect(screen.getByText('Flaky-test hunter')).toBeInTheDocument();
  });

  it('hands the chosen template back to the parent', async () => {
    const onPick = vi.fn();
    render(<LoopTemplates onPick={onPick} />);
    await userEvent.click(screen.getByRole('button', { name: /use the nightly maintenance template/i }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'nightly-maintenance' }));
  });

  it('every template carries a valid schedule mode', () => {
    for (const t of LOOP_TEMPLATES) {
      expect(['daily', 'interval', 'weekday']).toContain(t.schedule.mode);
      expect(t.goal.length).toBeGreaterThan(10);
    }
  });
});
