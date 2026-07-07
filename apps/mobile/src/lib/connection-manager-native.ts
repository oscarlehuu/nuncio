import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { probeCandidates } from '@nuncio/core/pairing-client';
import {
  createConnectionManager,
  type ConnectionManager,
} from './connection-manager';

/**
 * Wires the pure {@link createConnectionManager} state machine to React Native's
 * NetInfo and AppState and the shared candidate prober. Kept apart from the
 * manager itself so the manager stays free of native imports and unit-testable
 * under Node — this file is the thin, untested glue.
 */
export interface NativeManagerOptions {
  candidateUrls: string[];
  initialUrl: string;
  onActiveUrl: (url: string) => void;
  resync: () => void;
}

export function createNativeConnectionManager(options: NativeManagerOptions): ConnectionManager {
  return createConnectionManager({
    candidateUrls: options.candidateUrls,
    initialUrl: options.initialUrl,
    onActiveUrl: options.onActiveUrl,
    resync: options.resync,
    probe: (urls) => probeCandidates(urls),
    subscribeNetInfo: (onChange) => NetInfo.addEventListener(() => onChange()),
    subscribeAppState: (onChange) => {
      const sub = AppState.addEventListener('change', (state) => onChange(state === 'active'));
      return () => sub.remove();
    },
  });
}
