import { fullJitterBackoff } from '@nuncio/core/reconnect-backoff';

/**
 * Owns which candidate base URL is live for a paired phone. The relay client
 * stays dumb about the network: this manager re-probes the candidate URLs on a
 * NetInfo change or a WS close, switches the active URL when the winner changes,
 * drives an immediate reconnect when the app foregrounds, and otherwise backs
 * off with full jitter. It exposes a coarse `state` for the UI status pill.
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
  /** Called when the winning URL changes so the caller can reconfigure api + relay. */
  onActiveUrl: (url: string) => void;
  /** Reconnect/resubscribe the relay from the last seen seq. */
  resync: () => void;
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
  /** Report that the relay socket closed, so we re-probe + back off. */
  handleClose: () => void;
  start: () => void;
  dispose: () => void;
}

const SHUTDOWN_NOTICE = 'server_shutdown';

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
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleRetry = () => {
    if (disposed || retryTimer !== null) return;
    attempt += 1;
    const delay = fullJitterBackoff(attempt, { random: deps.random });
    retryTimer = setTimer(() => {
      retryTimer = null;
      void attemptConnect();
    }, delay);
  };

  const attemptConnect = async (): Promise<void> => {
    if (disposed) return;
    // A shutdown freeze is only broken by an explicit AppState/NetInfo kick,
    // which resets the state before calling here — so honor it and stay frozen.
    if (state === 'server-shutdown') return;
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
    attempt = 0;
    clearRetry();
    if (winner !== activeUrl) {
      activeUrl = winner;
      deps.onActiveUrl(winner);
    }
    deps.resync();
    setState('connected');
  };

  // An external kick (network came back, app foregrounded) bypasses the backoff
  // timer and, crucially, thaws a server-shutdown freeze.
  const kick = () => {
    if (disposed) return;
    clearRetry();
    attempt = 0;
    if (state === 'server-shutdown') setState('connecting');
    void attemptConnect();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    handleNotice(notice) {
      if (notice !== SHUTDOWN_NOTICE) return; // unknown notices don't change state
      // The desktop is going away deliberately; stop hammering it until the user
      // or the network signals a fresh chance.
      clearRetry();
      setState('server-shutdown');
    },
    handleClose() {
      if (disposed || state === 'server-shutdown') return;
      // Socket dropped — re-probe (the winner may have moved). attemptConnect
      // owns both the reset-on-success and the schedule-a-backoff-on-failure, so
      // there is no second retry to arm here.
      void attemptConnect();
    },
    start() {
      if (disposed) return;
      unsubscribers.push(deps.subscribeNetInfo(kick));
      unsubscribers.push(
        deps.subscribeAppState((active) => {
          if (active) kick();
        }),
      );
      void attemptConnect();
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
