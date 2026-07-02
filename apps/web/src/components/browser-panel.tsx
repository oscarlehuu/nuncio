import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Navigation, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface NuncioDesktopBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NuncioDesktopBrowserState {
  url: string | null;
  title: string | null;
  loading: boolean;
}

export interface NuncioDesktopBrowserApi {
  show: (payload: { id: string; bounds: NuncioDesktopBrowserBounds }) => Promise<NuncioDesktopBrowserState>;
  navigate: (id: string, url: string) => Promise<NuncioDesktopBrowserState>;
  reload: (id: string) => Promise<NuncioDesktopBrowserState>;
  resize: (id: string, bounds: NuncioDesktopBrowserBounds) => Promise<NuncioDesktopBrowserState>;
  hide: (id: string) => Promise<void>;
}

type DesktopBrowserWindow = Window & {
  nuncioDesktop?: {
    browser?: NuncioDesktopBrowserApi;
  };
};

export function getDesktopBrowserBridge(): NuncioDesktopBrowserApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as DesktopBrowserWindow).nuncioDesktop?.browser;
}

interface BrowserPanelProps {
  sessionId: string;
}

export function BrowserPanel({ sessionId }: BrowserPanelProps) {
  const desktopBrowser = getDesktopBrowserBridge();
  if (desktopBrowser) {
    return <DesktopBrowserPanel sessionId={sessionId} browser={desktopBrowser} />;
  }
  return null;
}

interface DesktopBrowserPanelProps extends BrowserPanelProps {
  browser: NuncioDesktopBrowserApi;
}

function elementBrowserBounds(element: HTMLElement): NuncioDesktopBrowserBounds {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

function DesktopBrowserPanel({ sessionId, browser }: DesktopBrowserPanelProps) {
  const [address, setAddress] = useState('');
  const [browserState, setBrowserState] = useState<NuncioDesktopBrowserState>({
    url: null,
    title: null,
    loading: false,
  });
  const [busy, setBusy] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressId = useMemo(() => `browser-address-${sessionId}`, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    const element = viewportRef.current;
    if (!element) return;

    const syncBounds = () => {
      const bounds = elementBrowserBounds(element);
      void browser.resize(sessionId, bounds).catch(() => undefined);
      return bounds;
    };

    const show = async () => {
      setBusy(true);
      try {
        const next = await browser.show({ id: sessionId, bounds: elementBrowserBounds(element) });
        if (cancelled) return;
        setBrowserState(next);
        setAddress(next.url ?? '');
      } catch (error) {
        if (!cancelled) toast.error(browserActionErrorMessage(error));
      } finally {
        if (!cancelled) setBusy(false);
      }
    };

    void show();

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            syncBounds();
          });
    observer?.observe(element);
    window.addEventListener('resize', syncBounds);

    return () => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener('resize', syncBounds);
      void browser.hide(sessionId);
    };
  }, [browser, sessionId]);

  const applyState = (next: NuncioDesktopBrowserState, fallbackUrl?: string) => {
    setBrowserState(next);
    setAddress(next.url ?? fallbackUrl ?? address);
  };

  const run = async (action: () => Promise<NuncioDesktopBrowserState>, fallbackUrl?: string) => {
    setBusy(true);
    try {
      applyState(await action(), fallbackUrl);
    } catch (error) {
      toast.error(browserActionErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const navigate = () => {
    const target = address.trim();
    if (!target || busy) return;
    void run(() => browser.navigate(sessionId, target), target);
  };

  const reloadTarget = browserState.url ?? address;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/40">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-2">
        <label htmlFor={addressId} className="sr-only">Address</label>
        <Input
          id={addressId}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              navigate();
            }
          }}
          placeholder="https://example.com"
          className="h-8 text-sm"
        />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Navigate"
          onClick={navigate}
          disabled={busy || !address.trim()}
        >
          <Navigation className="size-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Reload browser"
          onClick={() => void run(() => browser.reload(sessionId), reloadTarget)}
          disabled={busy || !reloadTarget.trim()}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        <div
          ref={viewportRef}
          role="group"
          aria-label="Embedded browser viewport"
          className="h-full min-h-[280px] bg-background"
        />
      </div>
    </div>
  );
}

function browserActionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Browser action failed';
}
