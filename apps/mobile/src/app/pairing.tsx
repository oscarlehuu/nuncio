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
import { apiFetch } from '@nuncio/core/http';
import { applyConnection } from '../lib/api-setup';
import { normalizeServerUrl, saveConnection } from '../lib/connection-store';
import { secureStore } from '../lib/secure-store-adapter';

export default function Pairing() {
  const router = useRouter();
  const [serverInput, setServerInput] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    const serverUrl = normalizeServerUrl(serverInput);
    if (!serverUrl) {
      setError('Enter your server address, e.g. mac.tailnet.ts.net');
      return;
    }
    setBusy(true);
    setError(null);
    const config = { serverUrl, token: token.trim() || null };
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
      await saveConnection(secureStore, config);
      router.replace('/');
    } catch {
      setError('Could not reach the server. Is Tailscale connected on this phone?');
    } finally {
      setBusy(false);
    }
  }, [router, serverInput, token]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background"
    >
      <View className="flex-1 justify-center px-8">
        <Text className="text-3xl font-semibold text-foreground">Pair with your machine</Text>
        <Text className="mt-2 text-muted-foreground">
          Enter the Tailscale address of the machine running Nuncio.
        </Text>

        <Text className="mt-8 text-sm text-muted-foreground">Server</Text>
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

        {error ? <Text className="mt-4 text-sm text-destructive">{error}</Text> : null}

        <Pressable
          onPress={connect}
          disabled={busy}
          className="mt-8 items-center rounded-lg bg-primary px-4 py-3"
        >
          {busy ? (
            <ActivityIndicator />
          ) : (
            <Text className="font-semibold text-primary-foreground">Connect</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
