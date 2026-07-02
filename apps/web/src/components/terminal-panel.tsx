import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { toWsUrl } from '../lib/api-base';

interface TerminalPanelProps {
  cwd?: string;
  onExit?: () => void;
}

type BackendSend = (data: string) => void;
type BackendResize = (cols: number, rows: number) => void;

export function TerminalPanel({ cwd, onExit }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sendInputRef = useRef<BackendSend>(() => {});
  const sendResizeRef = useRef<BackendResize>(() => {});
  const [notice, setNotice] = useState<string | null>(null);
  const terminalId = useMemo(() => createTerminalId(), []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let backendCleanup: (() => void) | undefined;
    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      theme: readTerminalTheme(container),
    });
    const fitAddon = new FitAddon();

    // xterm needs concrete color values, not CSS vars — re-resolve them from the
    // computed --terminal-bg/--terminal-fg whenever the theme (.dark) toggles.
    const applyTheme = () => term.options.theme = readTerminalTheme(container);
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const dimensions = () => ({ cols: term.cols || 80, rows: term.rows || 24 });
    const fitAndResize = () => {
      try {
        fitAddon.fit();
      } catch {
        // xterm can throw if the element is not measurable yet.
      }
      const { cols, rows } = dimensions();
      sendResizeRef.current(cols, rows);
    };

    term.loadAddon(fitAddon);
    term.open(container);
    fitAndResize();

    const inputDisposable = term.onData((data) => sendInputRef.current(data));
    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(container);

    const cleanupBackend = () => {
      backendCleanup?.();
      backendCleanup = undefined;
      sendInputRef.current = () => {};
      sendResizeRef.current = () => {};
    };

    const startWebSocketBackend = () => {
      if (disposed) return;
      const ws = new WebSocket(toWsUrl(location.origin, '/api/terminal'));
      backendCleanup = () => ws.close();
      sendInputRef.current = (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      };
      sendResizeRef.current = (cols, rows) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      };
      ws.onopen = () => {
        if (disposed) return;
        const { cols, rows } = dimensions();
        ws.send(JSON.stringify({ type: 'start', cwd, cols, rows }));
      };
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; data?: string; code?: number | null };
          if (message.type === 'data' && typeof message.data === 'string') {
            term.write(message.data);
          } else if (message.type === 'exit') {
            setNotice('Terminal disconnected — the in-browser terminal only works on this machine');
            onExit?.();
          }
        } catch {
          // Ignore malformed server frames.
        }
      };
      ws.onerror = () => {
        if (!disposed) {
          setNotice('Terminal disconnected — the in-browser terminal only works on this machine');
        }
      };
      ws.onclose = () => {
        if (!disposed) {
          setNotice('Terminal disconnected — the in-browser terminal only works on this machine');
        }
      };
    };

    const desktopTerminal = window.nuncioDesktop?.terminal;
    if (desktopTerminal && shouldUseDesktopTerminal(location.hostname)) {
      const unsubscribeData = desktopTerminal.onData((payload) => {
        if (payload.id === terminalId) {
          term.write(payload.data);
        }
      });
      const unsubscribeExit = desktopTerminal.onExit((payload) => {
        if (payload.id === terminalId) {
          setNotice('Terminal disconnected');
          onExit?.();
        }
      });
      backendCleanup = () => {
        unsubscribeData();
        unsubscribeExit();
        void desktopTerminal.kill(terminalId);
      };

      const { cols, rows } = dimensions();
      desktopTerminal
        .create({ id: terminalId, cwd, cols, rows })
        .then(() => {
          if (disposed) return;
          sendInputRef.current = (data) => void desktopTerminal.write(terminalId, data);
          sendResizeRef.current = (nextCols, nextRows) => {
            void desktopTerminal.resize(terminalId, nextCols, nextRows);
          };
        })
        .catch(() => {
          cleanupBackend();
          startWebSocketBackend();
        });
    } else {
      startWebSocketBackend();
    }

    return () => {
      disposed = true;
      cleanupBackend();
      themeObserver.disconnect();
      resizeObserver.disconnect();
      inputDisposable.dispose();
      term.dispose();
    };
  }, [cwd, terminalId]);

  return (
    <div className="flex h-72 min-h-0 flex-col bg-terminal-bg text-terminal-fg">
      {notice && (
        <div className="shrink-0 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          {notice}
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden p-2" data-testid="terminal-panel" />
    </div>
  );
}

/**
 * Resolve the theme-aware terminal surface tokens (--terminal-bg / --terminal-fg)
 * to concrete color strings for xterm, which cannot consume CSS variables.
 * Reads from the container's computed style so it tracks the active theme, with
 * a dark-surface fallback when computed values are unavailable (e.g. jsdom).
 */
export function readTerminalTheme(el: Element): { background: string; foreground: string } {
  const styles = getComputedStyle(el);
  const bg = styles.getPropertyValue('--terminal-bg').trim();
  const fg = styles.getPropertyValue('--terminal-fg').trim();
  return {
    background: bg || 'oklch(0.165 0.004 265)',
    foreground: fg || 'oklch(0.9 0.004 260)',
  };
}

/**
 * The desktop node-pty backend opens a shell on the CLIENT machine, so it is
 * only correct when the app is viewing its own local daemon. When the desktop
 * shell is connected to a remote server (non-loopback origin), the WebSocket
 * backend must win — the terminal belongs on the machine that holds the project.
 */
export function shouldUseDesktopTerminal(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function createTerminalId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
