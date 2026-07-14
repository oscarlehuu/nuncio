import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MousePointerClick, Navigation, RefreshCw, SquareDashedMousePointer } from 'lucide-react';
import { toast } from 'sonner';
import type { MessageAttachment } from '@nuncio/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DesignModeOverlay } from '@/components/design-mode-overlay';
import {
  buildDesignModeSteerMessage,
  designModeComponentFromPick,
  insertComponentChipAtCaret,
  type DesignModeComponent,
} from '@/lib/design-mode-serialize';

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

export interface NuncioDesktopDesignModePick {
  id: string;
  pick: {
    tag: string;
    id?: string;
    className?: string;
    ariaLabel?: string;
    placeholder?: string;
    name?: string;
    text?: string;
    xpath?: string;
    cssPath?: string;
    outerHTML?: string;
    styles?: Record<string, string>;
    bbox?: { x: number; y: number; width: number; height: number };
    cropPngBase64?: string;
    label?: string;
  };
}

export interface NuncioDesktopBrowserApi {
  show: (payload: { id: string; bounds: NuncioDesktopBrowserBounds }) => Promise<NuncioDesktopBrowserState>;
  navigate: (id: string, url: string) => Promise<NuncioDesktopBrowserState>;
  reload: (id: string) => Promise<NuncioDesktopBrowserState>;
  resize: (id: string, bounds: NuncioDesktopBrowserBounds) => Promise<NuncioDesktopBrowserState>;
  hide: (id: string) => Promise<void>;
  designModeEnter?: (id: string) => Promise<{ ok: boolean; id: string }>;
  designModeLeave?: (id: string) => Promise<{ ok: boolean; id: string }>;
  onDesignModePick?: (cb: (payload: NuncioDesktopDesignModePick) => void) => () => void;
  onDesignModeExit?: (cb: (payload: { id: string }) => void) => () => void;
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
  onSteer?: (message: string, attachments?: MessageAttachment[]) => Promise<void>;
  steerDisabled?: boolean;
  steerDisabledReason?: string;
  steering?: boolean;
}

export function BrowserPanel({
  sessionId,
  onSteer,
  steerDisabled = false,
  steerDisabledReason,
  steering = false,
}: BrowserPanelProps) {
  const desktopBrowser = getDesktopBrowserBridge();
  if (desktopBrowser) {
    return (
      <DesktopBrowserPanel
        sessionId={sessionId}
        browser={desktopBrowser}
        onSteer={onSteer}
        steerDisabled={steerDisabled}
        steerDisabledReason={steerDisabledReason}
        steering={steering}
      />
    );
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

/** Mirror apps/desktop/src/browser-url.js — bare `localhost:5173` is not a URI scheme. */
function normalizeAddressBarUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value)) return value;
  if (/^(about:|data:|chrome:|chrome-error:)/i.test(value)) return value;
  const bare = value.replace(/^\/+/, '');
  const hostToken = bare.split('/')[0] || '';
  const h = hostToken.toLowerCase();
  const loopback =
    h === 'localhost' ||
    h.startsWith('localhost:') ||
    h.endsWith('.localhost') ||
    h === '127.0.0.1' ||
    h.startsWith('127.0.0.1:') ||
    h === '0.0.0.0' ||
    h.startsWith('0.0.0.0:') ||
    h === '::1' ||
    h.startsWith('::1:') ||
    h === '[::1]' ||
    h.startsWith('[::1]:');
  return `${loopback ? 'http' : 'https'}://${bare}`;
}

function DesktopBrowserPanel({
  sessionId,
  browser,
  onSteer,
  steerDisabled = false,
  steerDisabledReason,
  steering = false,
}: DesktopBrowserPanelProps) {
  const [address, setAddress] = useState('');
  const [browserState, setBrowserState] = useState<NuncioDesktopBrowserState>({
    url: null,
    title: null,
    loading: false,
  });
  const [busy, setBusy] = useState(false);
  const [designMode, setDesignMode] = useState(false);
  const [designText, setDesignText] = useState('');
  const [designCaret, setDesignCaret] = useState(0);
  const [designComponents, setDesignComponents] = useState<DesignModeComponent[]>([]);
  const [focusNonce, setFocusNonce] = useState(0);
  const [sendingDesign, setSendingDesign] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef(0);
  const designComponentsRef = useRef<DesignModeComponent[]>([]);
  const addressId = useMemo(() => `browser-address-${sessionId}`, [sessionId]);

  const syncViewportBounds = useCallback(() => {
    const element = viewportRef.current;
    if (!element) return;
    void browser.resize(sessionId, elementBrowserBounds(element)).catch(() => undefined);
  }, [browser, sessionId]);

  useEffect(() => {
    caretRef.current = designCaret;
  }, [designCaret]);

  useEffect(() => {
    designComponentsRef.current = designComponents;
  }, [designComponents]);

  useEffect(() => {
    let cancelled = false;
    const element = viewportRef.current;
    if (!element) return;

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
            syncViewportBounds();
          });
    observer?.observe(element);
    window.addEventListener('resize', syncViewportBounds);

    return () => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener('resize', syncViewportBounds);
      void browser.designModeLeave?.(sessionId).catch(() => undefined);
      void browser.hide(sessionId);
    };
  }, [browser, sessionId, syncViewportBounds]);

  useEffect(() => {
    // When Design Mode toggles, remeasure so BrowserView leaves room for the pill.
    requestAnimationFrame(() => syncViewportBounds());
  }, [designMode, syncViewportBounds]);

  useEffect(() => {
    if (!designMode || !browser.onDesignModePick) return;
    return browser.onDesignModePick((payload) => {
      if (payload.id !== sessionId) return;
      setDesignText((text) => {
        const existing = designComponentsRef.current;
        const result = insertComponentChipAtCaret(
          text,
          caretRef.current,
          designModeComponentFromPick(payload.pick),
          existing,
        );
        if (result.capped) {
          toast.error(`Design Mode allows up to ${existing.length} components`);
          return text;
        }
        // Prefer guest-provided label when present (accessible name).
        if (typeof payload.pick.label === 'string' && payload.pick.label.trim()) {
          const labeled = result.components.map((c, i) =>
            i === result.components.length - 1
              ? { ...c, label: payload.pick.label!.trim() }
              : c,
          );
          // Rewrite last chip token in text if label differs.
          const prevToken = `[${result.components[result.components.length - 1]?.label}]`;
          const nextToken = `[${payload.pick.label.trim()}]`;
          const rewritten =
            prevToken !== nextToken ? result.text.replace(prevToken, nextToken) : result.text;
          setDesignComponents(labeled);
          setDesignCaret(rewritten.length);
          caretRef.current = rewritten.length;
          setFocusNonce((n) => n + 1);
          return rewritten;
        }
        setDesignComponents(result.components);
        setDesignCaret(result.caret);
        caretRef.current = result.caret;
        setFocusNonce((n) => n + 1);
        return result.text;
      });
    });
  }, [browser, designMode, sessionId]);

  useEffect(() => {
    if (!browser.onDesignModeExit) return;
    return browser.onDesignModeExit((payload) => {
      if (payload.id !== sessionId) return;
      setDesignMode(false);
    });
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
    const target = normalizeAddressBarUrl(address);
    if (!target || busy) return;
    setAddress(target);
    void run(() => browser.navigate(sessionId, target), target);
  };

  const toggleDesignMode = async () => {
    if (!browser.designModeEnter || !browser.designModeLeave) {
      toast.error('Design Mode requires a newer Nuncio Desktop build — restart the app');
      return;
    }
    const next = !designMode;
    setBusy(true);
    try {
      if (next) {
        await browser.designModeEnter(sessionId);
        setDesignMode(true);
        setDesignText('');
        setDesignCaret(0);
        setDesignComponents([]);
        setFocusNonce((n) => n + 1);
      } else {
        await browser.designModeLeave(sessionId);
        setDesignMode(false);
      }
      requestAnimationFrame(() => syncViewportBounds());
    } catch (error) {
      toast.error(browserActionErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const sendDesignSteer = async () => {
    if (!onSteer || steerDisabled || sendingDesign || steering) return;
    let payload;
    try {
      payload = buildDesignModeSteerMessage(designText, designComponents);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Nothing to send');
      return;
    }
    setSendingDesign(true);
    try {
      await onSteer(payload.message, payload.attachments.length > 0 ? payload.attachments : undefined);
      setDesignText('');
      setDesignCaret(0);
      setDesignComponents([]);
      setFocusNonce((n) => n + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to steer session');
    } finally {
      setSendingDesign(false);
    }
  };

  const reloadTarget = browserState.url ?? address;
  const designSupported = Boolean(browser.designModeEnter && browser.designModeLeave);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/40">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-2">
        <label htmlFor={addressId} className="sr-only">
          Address
        </label>
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
        <Button
          size="icon-sm"
          variant={designMode ? 'default' : 'ghost'}
          aria-label={designMode ? 'Exit Design Mode' : 'Enter Design Mode'}
          aria-pressed={designMode}
          onClick={() => void toggleDesignMode()}
          disabled={busy || !designSupported}
          title={
            designSupported
              ? 'Design Mode — click elements in the page, type in the pill below'
              : 'Desktop update required — restart Nuncio Desktop'
          }
        >
          {designMode ? (
            <MousePointerClick className="size-3.5" />
          ) : (
            <SquareDashedMousePointer className="size-3.5" />
          )}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <div
          ref={viewportRef}
          role="group"
          aria-label="Embedded browser viewport"
          className="min-h-[200px] w-full flex-1 bg-background"
        />
        {designMode ? (
          <DesignModeOverlay
            text={designText}
            caret={designCaret}
            components={designComponents}
            sending={sendingDesign || steering}
            disabled={steerDisabled || !onSteer}
            disabledReason={
              !onSteer
                ? 'Open a session to steer from Design Mode'
                : steerDisabledReason
            }
            focusNonce={focusNonce}
            onTextChange={(next, caret) => {
              setDesignText(next);
              setDesignCaret(caret);
              caretRef.current = caret;
            }}
            onSend={() => void sendDesignSteer()}
          />
        ) : null}
      </div>
    </div>
  );
}

function browserActionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Browser action failed';
}
