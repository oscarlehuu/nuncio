import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChunkErrorBoundary } from './chunk-error-boundary';

function Boom(): never {
  throw new Error('chunk import rejected');
}

describe('ChunkErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    render(
      <ChunkErrorBoundary>
        <span>island content</span>
      </ChunkErrorBoundary>,
    );
    expect(screen.getByText('island content')).toBeInTheDocument();
  });

  it('shows the fallback and logs when a child throws during render', () => {
    // React logs the caught error to console.error too; silence + assert ours ran.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ChunkErrorBoundary>
        <Boom />
      </ChunkErrorBoundary>,
    );

    expect(
      screen.getByText('This part failed to load after an update.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledWith(
      'Chunk failed to load',
      expect.any(Error),
      expect.anything(),
    );
  });

  it('reloads the page when the Reload button is clicked', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reloadSpy = vi.fn();
    // jsdom's location.reload is a non-configurable method, so we can't spyOn it
    // directly — swap the whole location object with a reload we control, then
    // restore it so the stub doesn't leak into other tests.
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload: reloadSpy },
    });

    try {
      render(
        <ChunkErrorBoundary>
          <Boom />
        </ChunkErrorBoundary>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: original,
      });
    }
  });
});
