import { fullJitterBackoff } from '@nuncio/core/reconnect-backoff';

/**
 * Owns which candidate base URL is live for a paired phone and is the SOLE
 * reconnect authority — the relay client never self-reconnects while a manager
 * is wired. It reacts to the relay's socket lifecycle: a close triggers a
 * re-probe of the candidate URLs, switches the active URL when the winner moved,
 * and reopens (with full-jitter backoff while offline); a `server_shutdown`
 * notice pauses reconnection for a bounded cooldown; foregrounding or a network
 * change kicks an immediate reconnect. It exposes a coarse `state` for the UI
 * status pill.
 *
 * Every side effect is injected so the whole state machine runs under a fake
 * clock in unit tests — nothing here imports React Native.
 */
export type ConnectionState = 'connected' | 'connecting' | 'offline' | 'server-shutdown';

export interface ConnectionManagerDeps {
  candidateUrls: string[];
  /** The URL claimed/probed at pair time; the first one we try. */
  initialUrl: string;
  /** Probe the candidates and resolve to the first healthy URL in order, or null. */
  probe: (urls: string[]) => Promise<string | null>;
  /** Called when the winning URL changes so the caller can reconfigure the api client. */
  onActiveUrl: (url: string) => void;
  /** Open (or reopen) the relay subscription against the current active URL. */
  reopen: () => void;
  /** Subscribe to network reachability flips; returns an unsubscribe. */
  subscribeNetInfo: (onChange: () => void) => () => void;
  /** Subscribe to foreground/background; `active` true when the app is foreground. */
  subscribeAppState: (onChange: (active: boolean) => void) => () => void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  random?: () => number;
}

export interface ConnectionManager {
  getState: () => ConnectionState;
  subscribe: (listener: (state: ConnectionState) => void) => () => void;
  /** Feed a top-level relay notice (server_shutdown) in. */
  handleNotice: (notice: string) => void;
  /** Report that the relay socket opened — the connection is healthy. */
  handleOpen: () => void;
  /** Report that the relay socket closed, so we re-probe / back off / cool down. */
  handleClose: () => void;
  /**
   * Whether the relay may self-reconnect. Always false while a manager is wired:
   * the manager is the sole reconnect authority — a socket close routes through
   * handleClose (probe → URL-switch → reopen, or cooldown on server_shutdown), so
   * letting the relay ALSO self-schedule would double-reconnect and keep
   * hammering a deliberately-downed desktop. The relay's built-in reconnect is
   * for the unmanaged (web) caller only.
   */
  shouldReconnect: () => boolean;
  start: () => void;
  dispose: () => void;
}

const SHUTDOWN_NOTICE = 'server_shutdown';
const SHUTDOWN_COOLDOWN_MIN_MS = 1_000;
const SHUTDOWN_COOLDOWN_JITTER_MS = 1_000;

export function createConnectionManager(deps: ConnectionManagerDeps): ConnectionManager {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));

  let state: ConnectionState = 'connecting';
  // Reads `state` without TS narrowing it to a single literal — the value can
  // change across an `await` (a shutdown notice arriving mid-probe), which the
  // control-flow analysis cannot see through.
  const currentState = (): ConnectionState => state;
  let activeUrl = deps.initialUrl;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimerToken = 0;
  let disposed = false;
  // A probe is async; if the network flips again mid-probe, only the latest run
  // may apply its result. This token invalidates stale in-flight probes.
  let probeToken = 0;
  const listeners = new Set<(state: ConnectionState) => void>();
  const unsubscribers: Array<() => void> = [];

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    for (const listener of listeners) listener(state);
  };

  const clearRetry = () => {
    retryTimerToken += 1;
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleRetry = () => {
    if (disposed || retryTimer !== null) return;
    attempt += 1;
    const delay = fullJitterBackoff(attempt, { random: deps.random });
    const token = ++retryTimerToken;
    retryTimer = setTimer(() => {
      if (disposed || token !== retryTimerToken) return;
      retryTimer = null;
      void reprobeAndReopen();
    }, delay);
  };

  const scheduleShutdownRecovery = () => {
    if (disposed || retryTimer !== null) return;
    const draw = Math.max(0, Math.min(1, (deps.random ?? Math.random)()));
    const delay = SHUTDOWN_COOLDOWN_MIN_MS + draw * SHUTDOWN_COOLDOWN_JITTER_MS;
    const token = ++retryTimerToken;
    retryTimer = setTimer(() => {
      if (disposed || token !== retryTimerToken || state !== 'server-shutdown') return;
      retryTimer = null;
      attempt = 0;
      setState('connecting');
      void reprobeAndReopen();
    }, delay);
  };

  // Probe the candidates, switch the active URL if the winner moved, then reopen
  // the subscription. State flips to 'connected' only when the socket actually
  // opens (handleOpen), so this never claims success prematurely.
  const reprobeAndReopen = async (): Promise<void> => {
    if (disposed || state === 'server-shutdown') return;
    setState('connecting');
    const token = ++probeToken;
    const winner = await deps.probe(deps.candidateUrls.length ? deps.candidateUrls : [activeUrl]);
    if (disposed || token !== probeToken) return; // a newer probe superseded this one
    if (currentState() === 'server-shutdown') return; // shutdown arrived while probing
    if (!winner) {
      setState('offline');
      scheduleRetry();
      return;
    }
    if (winner !== activeUrl) {
      activeUrl = winner;
      deps.onActiveUrl(winner);
    }
    deps.reopen();
  };

  // An external kick bypasses the backoff timer and thaws a server-shutdown
  // cooldown. Connected foreground recovery deliberately reopens below.
  const kick = () => {
    if (disposed || state === 'connected') return;
    clearRetry();
    attempt = 0;
    if (state === 'server-shutdown') setState('connecting');
    void reprobeAndReopen();
  };

  // A network change can move the best endpoint even while the current socket
  // still limps along (Wi-Fi→cellular makes a LAN URL dead but a Funnel URL
  // live). When connected, re-probe and act only on a genuine winner change so a
  // healthy connection on the same URL is left undisturbed (no state flip, no
  // reopen). When NOT connected — including a server_shutdown cooldown — a network
  // change is a recovery signal and thaws exactly like a foreground kick, so a
  // Tailscale/network recovery reconnects without needing the app foregrounded.
  const onNetworkChange = async (): Promise<void> => {
    if (disposed) return;
    if (state !== 'connected') {
      kick();
      return;
    }
    const token = ++probeToken;
    const winner = await deps.probe(deps.candidateUrls.length ? deps.candidateUrls : [activeUrl]);
    if (disposed || token !== probeToken || currentState() !== 'connected') return;
    if (winner && winner !== activeUrl) {
      activeUrl = winner;
      deps.onActiveUrl(winner);
      deps.reopen();
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    handleNotice(notice) {
      if (notice !== SHUTDOWN_NOTICE) return; // unknown notices don't change state
      // Pause long enough for a deliberate restart, then probe automatically so
      // a foreground phone cannot freeze forever without another OS signal.
      clearRetry();
      setState('server-shutdown');
      scheduleShutdownRecovery();
    },
    handleOpen() {
      if (disposed) return;
      attempt = 0;
      clearRetry();
      setState('connected');
    },
    handleClose() {
      if (disposed || state === 'server-shutdown') return;
      // Socket dropped — re-probe (the winner may have moved) and reopen, or back
      // off if every candidate is down. reprobeAndReopen owns both outcomes.
      void reprobeAndReopen();
    },
    shouldReconnect() {
      return false;
    },
    start() {
      if (disposed) return;
      unsubscribers.push(deps.subscribeNetInfo(() => void onNetworkChange()));
      unsubscribers.push(
        deps.subscribeAppState((active) => {
          if (!active || disposed) return;
          if (state === 'connected') {
            // The OS can suspend a live-looking socket without a close event.
            // The caller reopens from its monotonic last-seen cursor.
            deps.reopen();
            return;
          }
          kick();
        }),
      );
      // The caller has already opened the initial subscription at initialUrl;
      // handleOpen/handleClose take it from here. Start 'connecting' until the
      // first open resolves.
      setState('connecting');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearRetry();
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers.length = 0;
      listeners.clear();
    },
  };
}
