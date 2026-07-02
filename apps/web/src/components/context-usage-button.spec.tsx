import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContextUsageButton } from './context-usage-button';
import type { ContextUsage } from '@/lib/use-context-usage';

function usageAt(percentage: number): ContextUsage {
  return {
    percentage,
    total: 1000,
    window: 8000,
    breakdown: [{ label: 'Conversation', tokens: 1000, color: 'var(--chart-1)' }],
  };
}

/**
 * The progress ring must colour itself from the semantic status tokens, never
 * from raw status hex — so the theme (dark/light) owns the palette. We assert on
 * the resolved stroke attribute since the colour is inline on the <circle>.
 */
describe('ContextUsageButton status colour', () => {
  function progressStroke(container: HTMLElement): string {
    const circles = container.querySelectorAll('circle');
    // Second circle is the progress arc (first is the track).
    return circles[1]?.getAttribute('stroke') ?? '';
  }

  it('uses the error token when context is nearly full', () => {
    const { container } = render(<ContextUsageButton usage={usageAt(85)} />);
    expect(progressStroke(container)).toBe('var(--color-error)');
  });

  it('uses the warning token as context fills', () => {
    const { container } = render(<ContextUsageButton usage={usageAt(60)} />);
    expect(progressStroke(container)).toBe('var(--color-warning)');
  });

  it('uses the neutral token at low usage', () => {
    const { container } = render(<ContextUsageButton usage={usageAt(20)} />);
    expect(progressStroke(container)).toBe('var(--color-neutral)');
  });

  it('never emits a raw status hex literal for the ring colour', () => {
    const { container } = render(<ContextUsageButton usage={usageAt(90)} />);
    const stroke = progressStroke(container);
    expect(stroke).not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(stroke.startsWith('var(--color-')).toBe(true);
  });

  it('renders the usage percentage on the trigger', () => {
    render(<ContextUsageButton usage={usageAt(42)} />);
    expect(screen.getByTestId('context-usage-button')).toHaveTextContent('42%');
  });
});
