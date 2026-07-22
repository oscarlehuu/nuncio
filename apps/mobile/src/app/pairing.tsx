import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { QrCode, ShieldCheck, Wifi } from 'lucide-react-native';
import {
  claimPairing,
  parsePairingQr,
  PairingClaimError,
  probeCandidates,
} from '@nuncio/core/pairing-client';
import { applyConnection } from '../lib/api-setup';
import { normalizeServerUrl, type ConnectionConfig } from '../lib/connection-store';
import { connectManualCandidate } from '../lib/manual-pairing-controller';
import { persistThenApply } from '../lib/persist-then-apply';
import { secureStore } from '../lib/secure-store-adapter';
import { registerForPush } from '../lib/push-registration';
import { QrScanner } from '../components/qr-scanner';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Text } from '../components/ui/text';

export default function Pairing() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [serverInput, setServerInput] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  // Persist the credential BEFORE swapping it into the live client or routing.
  // The QR pairing secret is single-use and returned exactly once, so if the
  // secure-store write fails we must NOT proceed on an unpersisted secret that a
  // crash or restart would lose (forcing the user to regenerate the QR). Returns
  // true only when the connection is safely saved AND applied.
  const finish = useCallback(
    async (config: ConnectionConfig): Promise<boolean> => {
      const outcome = await persistThenApply(secureStore, config, applyConnection);
      if (outcome === 'save-failed') {
        setError("Couldn't save the pairing on this device. Try again.");
        return false;
      }
      router.replace('/');
      void registerForPush();
      return true;
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
    try {
      const result = await connectManualCandidate(config, {
        fetchImpl: (input, init) => globalThis.fetch(input, init),
        store: secureStore,
        apply: applyConnection,
      });
      if (result.kind === 'unauthorized') {
        setError('This server needs the access token (Settings → Remote access on the server).');
        return;
      }
      if (result.kind === 'server-error') {
        setError(`Server answered ${result.status} — is this a Nuncio server?`);
        return;
      }
      if (result.kind === 'network-error') {
        setError('Could not reach the server. Is Tailscale connected on this phone?');
        return;
      }
      if (result.kind === 'persist-error') {
        setError("Couldn't save the pairing on this device. Try again.");
        return;
      }
      router.replace('/');
      void registerForPush();
    } finally {
      setBusy(false);
    }
  }, [router, serverInput, token]);

  if (scanning) {
    return <QrScanner onScan={(t) => void onScan(t)} onCancel={() => setScanning(false)} />;
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
        className="flex-1"
        style={{ flex: 1 }}
      >
        <ScrollView
          className="flex-1"
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{
            flexGrow: 1,
            paddingBottom: insets.bottom + 24,
            paddingHorizontal: 24,
            paddingTop: 32,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View className="items-center">
            <View className="h-16 w-16 items-center justify-center rounded-3xl bg-primary shadow-sm shadow-black/20">
              <Text className="text-3xl font-bold text-primary-foreground">N</Text>
            </View>
            <Text className="mt-5 text-center text-3xl font-semibold tracking-tight text-foreground">
              Pair with your machine
            </Text>
            <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
              Connect this phone to your Nuncio server to delegate and review agent work.
            </Text>
          </View>

          <Card className="mt-7 gap-0 rounded-xl border-border p-4 shadow-none">
            <View className="flex-row items-center gap-3">
              <View className={`h-9 w-9 items-center justify-center rounded-full ${error ? 'bg-destructive/15' : 'bg-secondary'}`}>
                {error ? <Wifi color="#f5605b" size={17} /> : <ShieldCheck color="#4ade80" size={17} />}
              </View>
              <View className="flex-1">
                <Text className="font-semibold text-foreground">
                  {busy ? 'Checking connection…' : error ? 'Connection needs attention' : serverInput.trim() ? 'Ready to connect' : 'Awaiting pairing'}
                </Text>
                <Text className="mt-1 text-xs text-muted-foreground">
                  {error ?? 'Use a QR code for the fastest secure setup.'}
                </Text>
              </View>
            </View>
          </Card>

          <Button
            onPress={() => {
              setError(null);
              setScanning(true);
            }}
            disabled={busy}
            size="lg"
            className="mt-4 rounded-xl"
          >
            {busy ? <ActivityIndicator color="#161719" /> : <QrCode color="#161719" size={18} />}
            <Text>Scan pairing QR code</Text>
          </Button>

          <View className="my-6 flex-row items-center gap-3">
            <View className="h-px flex-1 bg-border" />
            <Text className="text-xs text-muted-foreground">or connect manually</Text>
            <View className="h-px flex-1 bg-border" />
          </View>

          <Text className="mb-2 text-sm font-medium text-foreground">Server address</Text>
          <Input
            placeholder="mac.tailnet.ts.net"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={serverInput}
            onChangeText={setServerInput}
          />

          <Text className="mb-2 mt-4 text-sm font-medium text-foreground">Access token <Text className="font-normal text-muted-foreground">(optional)</Text></Text>
          <Input
            placeholder="Paste token"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            value={token}
            onChangeText={setToken}
          />

          <Button
            onPress={connectManually}
            disabled={busy}
            variant="outline"
            size="lg"
            className="mt-5 rounded-xl"
          >
            <Text>Connect</Text>
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
