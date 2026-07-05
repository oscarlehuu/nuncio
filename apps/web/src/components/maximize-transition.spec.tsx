import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MaximizeTransition } from './maximize-transition';

// Only left/top/width/height are read by the FLIP maths.
const rect = { left: 40, top: 60, width: 120, height: 90 } as unknown as DOMRect;

describe('MaximizeTransition', () => {
  it('renders the maximized view (its children)', () => {
    render(
      <MaximizeTransition originRect={rect} closing={false} onExited={vi.fn()}>
        <div>full session view</div>
      </MaximizeTransition>,
    );
    expect(screen.getByText('full session view')).toBeInTheDocument();
  });

  it('does not signal exit while it is open', () => {
    const onExited = vi.fn();
    render(
      <MaximizeTransition originRect={rect} closing={false} onExited={onExited}>
        <div>open</div>
      </MaximizeTransition>,
    );
    expect(onExited).not.toHaveBeenCalled();
  });

  it('still completes the restore when the Web Animations API is unavailable', async () => {
    // jsdom has no element.animate, so the shrink animation is skipped — the
    // component must ALWAYS hand control back via onExited so the grid can remount
    // and never gets wedged behind a stuck overlay.
    const onExited = vi.fn();
    const { rerender } = render(
      <MaximizeTransition originRect={rect} closing={false} onExited={onExited}>
        <div>view</div>
      </MaximizeTransition>,
    );
    rerender(
      <MaximizeTransition originRect={rect} closing onExited={onExited}>
        <div>view</div>
      </MaximizeTransition>,
    );
    await waitFor(() => expect(onExited).toHaveBeenCalledTimes(1));
  });

  it('exits immediately when no origin rect was captured', async () => {
    const onExited = vi.fn();
    const { rerender } = render(
      <MaximizeTransition originRect={null} closing={false} onExited={onExited}>
        <div>view</div>
      </MaximizeTransition>,
    );
    rerender(
      <MaximizeTransition originRect={null} closing onExited={onExited}>
        <div>view</div>
      </MaximizeTransition>,
    );
    await waitFor(() => expect(onExited).toHaveBeenCalledTimes(1));
  });
});
