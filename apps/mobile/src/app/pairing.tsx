import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  claimPairing,
  parsePairingQr,
  PairingClaimError,
  probeCandidates,
} from '@nuncio/core/pairing-client';
import { apiFetch } from '@nuncio/core/http';
import { applyConnection } from '../lib/api-setup';
import {
  normalizeServerUrl,
  saveConnection,
  type ConnectionConfig,
} from '../lib/connection-store';
import { secureStore } from '../lib/secure-store-adapter';
import { registerForPush } from '../lib/push-registration';
import { QrScanner } from '../components/qr-scanner';

export default function Pairing() {
  const router = useRouter();
  const [serverInput, setServerInput] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const finish = useCallback(
    async (config: ConnectionConfig) => {
      applyConnection(config);
      await saveConnection(secureStore, config);
      router.replace('/');
      void registerForPush();
    },
    [router],
  );

  // Scan → parse → probe (LAN-first) → claim → persist v2. Every failure lands
  // in a specific message; the scanner closes so the error is readable.
  const onScan = useCallback(
    async (text: string) => {
      setScanning(false);
      const parsed = parsePairingQr(text);
      if (!parsed) {
        setError("That QR code isn't a Nuncio pairing code.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const baseUrl = await probeCandidates(parsed.urls);
        if (!baseUrl) {
          setError("Can't reach the desktop — is this phone on the same Wi-Fi?");
          return;
        }
        const claim = await claimPairing(baseUrl, { code: parsed.code, platform: Platform.OS });
        await finish({
          serverUrl: baseUrl,
          token: null,
          deviceId: claim.deviceId,
          deviceSecret: claim.deviceSecret,
          candidateUrls: parsed.urls,
        });
      } catch (err) {
        if (err instanceof PairingClaimError && err.reason === 'expired') {
          setError('This code expired. Show a fresh QR code on the desktop and scan again.');
        } else if (err instanceof PairingClaimError && err.reason === 'too-many') {
          setError('Too many attempts. Wait a moment, then scan again.');
        } else {
          setError('Pairing failed. Try scanning again.');
        }
      } finally {
        setBusy(false);
      }
    },
    [finish],
  );

  const connectManually = useCallback(async () => {
    const serverUrl = normalizeServerUrl(serverInput);
    if (!serverUrl) {
      setError('Enter your server address, e.g. mac.tailnet.ts.net');
      return;
    }
    setBusy(true);
    setError(null);
    const config: ConnectionConfig = { serverUrl, token: token.trim() || null };
    applyConnection(config);
    try {
      const res = await apiFetch('/api/health');
      if (res.status === 401 || res.status === 403) {
        setError('This server needs the access token (Settings → Remote access on the server).');
        return;
      }
      if (!res.ok) {
        setError(`Server answered ${res.status} — is this a Nuncio server?`);
        return;
      }
      await finish(config);
    } catch {
      setError('Could not reach the server. Is Tailscale connected on this phone?');
    } finally {
      setBusy(false);
    }
  }, [finish, serverInput, token]);

  if (scanning) {
    return <QrScanner onScan={(t) => void onScan(t)} onCancel={() => setScanning(false)} />;
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background"
    >
      <View className="flex-1 justify-center px-8">
        <Text className="text-3xl font-semibold text-foreground">Pair with your machine</Text>
        <Text className="mt-2 text-muted-foreground">
          Scan the QR code in Nuncio → Settings → Remote access, or enter the address by hand.
        </Text>

        <Pressable
          onPress={() => {
            setError(null);
            setScanning(true);
          }}
          disabled={busy}
          className="mt-8 items-center rounded-lg bg-primary px-4 py-3"
        >
          {busy ? (
            <ActivityIndicator />
          ) : (
            <Text className="font-semibold text-primary-foreground">Scan QR code</Text>
          )}
        </Pressable>

        {error ? <Text className="mt-4 text-sm text-destructive">{error}</Text> : null}

        <View className="mt-10 flex-row items-center gap-3">
          <View className="h-px flex-1 bg-border" />
          <Text className="text-xs text-muted-foreground">or enter manually</Text>
          <View className="h-px flex-1 bg-border" />
        </View>

        <Text className="mt-6 text-sm text-muted-foreground">Server</Text>
        <TextInput
          className="mt-2 rounded-lg border border-border px-4 py-3 text-foreground"
          placeholder="mac.tailnet.ts.net"
          placeholderTextColor="#6b7280"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={serverInput}
          onChangeText={setServerInput}
        />

        <Text className="mt-4 text-sm text-muted-foreground">Access token (optional on your own tailnet)</Text>
        <TextInput
          className="mt-2 rounded-lg border border-border px-4 py-3 text-foreground"
          placeholder="paste token"
          placeholderTextColor="#6b7280"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          value={token}
          onChangeText={setToken}
        />

        <Pressable
          onPress={connectManually}
          disabled={busy}
          className="mt-6 items-center rounded-lg border border-border px-4 py-3"
        >
          <Text className="font-semibold text-foreground">Connect</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
