import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueuedSteersPanel } from './queued-steers-panel';

describe('QueuedSteersPanel', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = render(
      <QueuedSteersPanel steers={[]} onStartMultitasking={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists queued steers and starts multitasking', async () => {
    const onStartMultitasking = vi.fn();
    const user = userEvent.setup();
    render(
      <QueuedSteersPanel
        steers={[
          { key: 'q1', text: 'Fix the login bug' },
          { key: 'q2', text: 'Add tests' },
        ]}
        onStartMultitasking={onStartMultitasking}
      />,
    );

    expect(screen.getByTestId('queued-steers-panel')).toBeInTheDocument();
    expect(screen.getByText('2 Queued')).toBeInTheDocument();
    expect(screen.getByText('Fix the login bug')).toBeInTheDocument();
    expect(screen.getByText('Add tests')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start Multitasking' }));
    expect(onStartMultitasking).toHaveBeenCalledOnce();
  });

  it('disables multitask while starting', () => {
    render(
      <QueuedSteersPanel
        steers={[{ key: 'q1', text: 'One steer' }]}
        onStartMultitasking={vi.fn()}
        starting
      />,
    );
    expect(screen.getByRole('button', { name: 'Start Multitasking' })).toBeDisabled();
  });
});
