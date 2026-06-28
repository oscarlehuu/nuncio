import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ModelEffortSlider } from './model-effort-slider';

describe('ModelEffortSlider', () => {
  const choices = [
    { id: 'low', label: 'Low', isDefault: true },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
  ];

  it('renders faster/smarter labels and a range input', () => {
    render(
      <ModelEffortSlider label="Reasoning" choices={choices} value="low" onChange={vi.fn()} />,
    );
    expect(screen.getByText('Faster')).toBeInTheDocument();
    expect(screen.getByText('Smarter')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: /reasoning effort/i })).toBeInTheDocument();
  });

  it('shows the label with the current value in the header', () => {
    render(
      <ModelEffortSlider label="Reasoning" choices={choices} value="high" onChange={vi.fn()} />,
    );
    expect(screen.getByText('Reasoning')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('calls onChange when the range value changes', () => {
    const onChange = vi.fn();
    render(
      <ModelEffortSlider label="Reasoning" choices={choices} value="low" onChange={onChange} />,
    );
    fireEvent.change(screen.getByRole('slider', { name: /reasoning effort/i }), {
      target: { value: '2' },
    });
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('commits the nearest step while dragging the rail', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ModelEffortSlider label="Reasoning" choices={choices} value="low" onChange={onChange} />,
    );
    const rail = container.querySelector('[data-slot="effort-rail"]') as HTMLElement;
    expect(rail).toBeTruthy();
    rail.getBoundingClientRect = () =>
      ({ left: 0, width: 100, top: 0, right: 100, bottom: 0, height: 0, x: 0, y: 0 }) as DOMRect;

    // Press near the far right, then drag back to the middle.
    fireEvent.pointerDown(rail, { clientX: 100, button: 0, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith('high');

    fireEvent.pointerMove(rail, { clientX: 50, button: 0, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith('medium');

    // After release, hover moves are ignored.
    fireEvent.pointerUp(rail, { clientX: 50, button: 0, pointerId: 1 });
    onChange.mockClear();
    fireEvent.pointerMove(rail, { clientX: 0, button: 0, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
