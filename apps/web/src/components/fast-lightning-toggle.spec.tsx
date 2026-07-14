import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FastLightningToggle } from './fast-lightning-toggle';

describe('FastLightningToggle', () => {
  it('exposes an aria-label when fast mode is active', () => {
    render(<FastLightningToggle active />);
    expect(screen.getByLabelText('Fast mode on')).toBeInTheDocument();
  });

  it('hides from assistive tech when inactive', () => {
    const { container } = render(<FastLightningToggle active={false} />);
    expect(screen.queryByLabelText('Fast mode on')).not.toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('applies success styling when active', () => {
    const { container } = render(<FastLightningToggle active className="extra" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/text-success/);
    expect(root.className).toMatch(/extra/);
  });
});
