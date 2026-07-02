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
      theme: {
        background: '#0d0f12',
        foreground: '#e5e7eb',
      },
    });
    const fitAddon = new FitAddon();

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
      resizeObserver.disconnect();
      inputDisposable.dispose();
      term.dispose();
    };
  }, [cwd, terminalId]);

  return (
    <div className="flex h-72 min-h-0 flex-col bg-[#0d0f12] text-foreground">
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
