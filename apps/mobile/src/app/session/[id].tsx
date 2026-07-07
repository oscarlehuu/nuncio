import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  archiveSession,
  deleteSession,
  fetchSession,
  pauseSession,
  restoreSession,
  statusLabel,
  type Session,
} from '@nuncio/core/api';
import { useSessionTranscript } from '../../lib/use-session-transcript';
import { useTranscriptBlocks } from '../../lib/use-transcript-blocks';
import { TranscriptBlockView } from '../../components/transcript-block-view';
import { ConnectionPill } from '../../components/connection-pill';

export default function SessionDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionId = typeof id === 'string' ? id : null;
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList>(null);

  const { events, steer, connectionState } = useSessionTranscript(sessionId);
  const blocks = useTranscriptBlocks(events);

  const reloadSession = useCallback(() => {
    if (!sessionId) return;
    fetchSession(sessionId).then(setSession).catch(() => {});
  }, [sessionId]);

  useEffect(reloadSession, [reloadSession]);
  // Status events change lifecycle state — keep the header in sync.
  useEffect(() => {
    const last = events[events.length - 1];
    if (last?.type === 'status') reloadSession();
  }, [events, reloadSession]);

  const send = useCallback(async () => {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await steer(text);
      setMessage('');
    } catch (err) {
      const detail = (err as { message?: string })?.message;
      setError(detail || 'Steer failed.');
    } finally {
      setSending(false);
    }
  }, [message, sending, steer]);

  const runAction = useCallback(
    async (action: (id: string) => Promise<unknown>, label: string) => {
      if (!sessionId) return;
      try {
        await action(sessionId);
        reloadSession();
      } catch {
        setError(`${label} failed.`);
      }
    },
    [sessionId, reloadSession],
  );

  const showActions = useCallback(() => {
    if (!session || !sessionId) return;
    const archived = session.status === 'ARCHIVED';
    const buttons = archived
      ? [
          { text: 'Restore', onPress: () => void runAction(restoreSession, 'Restore') },
          {
            text: 'Delete permanently',
            style: 'destructive' as const,
            onPress: () =>
              Alert.alert('Delete session?', 'The transcript is gone for good.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => {
                    void deleteSession(sessionId).then(() => router.back());
                  },
                },
              ]),
          },
        ]
      : [
          ...(session.status === 'RUNNING'
            ? [{ text: 'Pause', onPress: () => void runAction(pauseSession, 'Pause') }]
            : []),
          { text: 'Archive', onPress: () => void runAction(archiveSession, 'Archive') },
        ];
    Alert.alert(session.title || 'Session', statusLabel(session.status), [
      ...buttons,
      { text: 'Close', style: 'cancel' },
    ]);
  }, [session, sessionId, runAction, router]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background pt-16"
    >
      <View className="flex-row items-center gap-3 border-b border-border px-4 pb-3">
        <Pressable onPress={() => router.back()}>
          <Text className="text-2xl text-muted-foreground">‹</Text>
        </Pressable>
        <View className="flex-1">
          <Text className="font-semibold text-foreground" numberOfLines={1}>
            {session?.title || session?.prompt || 'Session'}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {session ? statusLabel(session.status) : '…'}
          </Text>
        </View>
        <ConnectionPill state={connectionState} />
        <Pressable onPress={showActions} className="px-2 py-1">
          <Text className="text-xl text-muted-foreground">⋯</Text>
        </Pressable>
      </View>

      <FlatList
        ref={listRef}
        className="flex-1 px-3"
        data={blocks}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => <TranscriptBlockView block={item} />}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />

      {error ? <Text className="px-4 py-1 text-sm text-destructive">{error}</Text> : null}

      <View className="flex-row items-end gap-2 border-t border-border px-3 py-2 pb-8">
        <TextInput
          className="max-h-28 flex-1 rounded-lg border border-border px-3 py-2 text-foreground"
          placeholder="Steer the agent…"
          placeholderTextColor="#6b7280"
          multiline
          value={message}
          onChangeText={setMessage}
        />
        <Pressable
          onPress={send}
          disabled={sending || !message.trim()}
          className={`rounded-lg px-4 py-2.5 ${sending || !message.trim() ? 'bg-muted' : 'bg-primary'}`}
        >
          {sending ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text className="font-semibold text-primary-foreground">Send</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
