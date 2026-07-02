import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserPanel } from './browser-panel';

const originalResizeObserver = globalThis.ResizeObserver;

class MockResizeObserver {
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this);
  }

  disconnect() {}
  unobserve() {}
}

describe('BrowserPanel', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: MockResizeObserver,
    });
    delete (window as Window & { nuncioDesktop?: unknown }).nuncioDesktop;
  });

  afterEach(() => {
    delete (window as Window & { nuncioDesktop?: unknown }).nuncioDesktop;
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: originalResizeObserver,
    });
  });

  it('renders nothing when the desktop browser bridge is unavailable', () => {
    const { container } = render(<BrowserPanel sessionId="s1" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('uses the desktop embedded browser bridge when available', async () => {
    const show = vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example', loading: false });
    const navigate = vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example', loading: false });
    const reload = vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example', loading: false });
    const resize = vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example', loading: false });
    const hide = vi.fn().mockResolvedValue(undefined);
    (window as Window & { nuncioDesktop?: unknown }).nuncioDesktop = {
      browser: { show, navigate, reload, resize, hide },
    };

    render(<BrowserPanel sessionId="s1" />);

    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(screen.queryByLabelText('Type into page')).toBeNull();

    await userEvent.clear(screen.getByLabelText('Address'));
    await userEvent.type(screen.getByLabelText('Address'), 'example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Navigate' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('s1', 'example.com'));
    expect(reload).not.toHaveBeenCalled();
    expect(resize).toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Embedded browser viewport' })).toBeInTheDocument();
  });
});
