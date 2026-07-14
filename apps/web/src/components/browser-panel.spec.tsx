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

function installBrowserBridge() {
  const show = vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example', loading: false });
  const navigate = vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example', loading: false });
  const reload = vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example', loading: false });
  const resize = vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example', loading: false });
  const hide = vi.fn().mockResolvedValue(undefined);
  const designModeEnter = vi.fn().mockResolvedValue({ ok: true, id: 's1' });
  const designModeLeave = vi.fn().mockResolvedValue({ ok: true, id: 's1' });
  let pickHandler: ((payload: {
    id: string;
    pick: Record<string, unknown>;
  }) => void) | null = null;

  const onDesignModePick = vi.fn((cb: (payload: { id: string; pick: Record<string, unknown> }) => void) => {
    pickHandler = cb;
    return () => {
      pickHandler = null;
    };
  });

  window.nuncioDesktop = {
    browser: {
      show,
      navigate,
      reload,
      resize,
      hide,
      designModeEnter,
      designModeLeave,
      onDesignModePick,
    },
  };

  return {
    show,
    navigate,
    designModeEnter,
    emitPick: (payload: { id: string; pick: Record<string, unknown> }) => pickHandler?.(payload),
  };
}

describe('BrowserPanel', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: MockResizeObserver,
    });
    delete window.nuncioDesktop;
  });

  afterEach(() => {
    delete window.nuncioDesktop;
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

  it('shows the Design Mode pill immediately and inserts chips from page picks', async () => {
    const bridge = installBrowserBridge();
    const onSteer = vi.fn().mockResolvedValue(undefined);
    render(<BrowserPanel sessionId="s1" onSteer={onSteer} />);

    await waitFor(() => expect(bridge.show).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Enter Design Mode' }));
    await waitFor(() => expect(bridge.designModeEnter).toHaveBeenCalledWith('s1'));

    expect(screen.getByTestId('design-mode-overlay')).toBeInTheDocument();
    expect(screen.getByLabelText('Design Mode prompt')).toBeInTheDocument();

    bridge.emitPick({
      id: 's1',
      pick: {
        tag: 'input',
        placeholder: 'Search',
        className: 'RNNXgb',
        label: 'Search',
        xpath: '/html/body/input',
        cssPath: 'input',
        outerHTML: '<input placeholder="Search" />',
        styles: {},
        bbox: { x: 1, y: 2, width: 3, height: 4 },
        cropPngBase64: 'crop-a',
      },
    });

    await waitFor(() => expect(screen.getByLabelText('Design Mode prompt')).toHaveValue('[Search] '));
    expect(screen.getByText('Search')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Send Design Mode steer' }));
    await waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1));
    const [message, attachments] = onSteer.mock.calls[0]!;
    expect(message).toContain('[Search]');
    expect(attachments).toEqual([{ kind: 'image', mimeType: 'image/png', data: 'crop-a' }]);
  });
});
