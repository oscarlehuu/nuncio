import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { InteractiveDemo } from './interactive-demo';
import { SCENARIOS, scenarioDuration } from '../lib/demo-script';

describe('<InteractiveDemo />', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function drainScenario() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(scenarioDuration(SCENARIOS[0]) + 100);
    });
  }

  it('shows the first scenario prompt and a chip per scenario', () => {
    render(<InteractiveDemo />);
    expect(screen.getAllByText(SCENARIOS[0].prompt).length).toBeGreaterThan(0);
    for (const scenario of SCENARIOS) {
      expect(screen.getByRole('tab', { name: scenario.chip })).toBeInTheDocument();
    }
  });

  it('streams to IDLE and enables steering when finished', async () => {
    render(<InteractiveDemo />);
    const input = screen.getByLabelText('Steer the agent') as HTMLInputElement;
    expect(input).toBeDisabled();

    await drainScenario();

    expect(input).not.toBeDisabled();
    expect(screen.getByText('IDLE')).toBeInTheDocument();
  });

  it('appends a follow-up when steered after completion', async () => {
    render(<InteractiveDemo />);
    await drainScenario();

    const input = screen.getByLabelText('Steer the agent') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Ship it now' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(screen.getByText('Ship it now')).toBeInTheDocument();
    expect(screen.getByText(/PR #\d+ opened/)).toBeInTheDocument();
  });

  it('switches scenarios when another chip is clicked', () => {
    render(<InteractiveDemo />);
    fireEvent.click(screen.getByRole('tab', { name: SCENARIOS[1].chip }));
    expect(screen.getAllByText(SCENARIOS[1].prompt).length).toBeGreaterThan(0);
  });
});
