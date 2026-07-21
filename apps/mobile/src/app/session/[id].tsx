import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { Text as UItext } from '../../components/ui/text';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRightLeft,
  MoreHorizontal,
  Paperclip,
  Pause,
  Play,
  Send,
  Trash2,
} from 'lucide-react-native';
import {
  archiveSession,
  deleteSession,
  fetchModels,
  fetchSession,
  handoffSessionTo,
  pauseSession,
  restoreSession,
  statusLabel,
  type Session,
} from '@nuncio/core/api';
import { providerMeta, type ModelProvider } from '@nuncio/core/model-providers';
import { useSessionTranscript } from '../../lib/use-session-transcript';
import { useTranscriptBlocks } from '../../lib/use-transcript-blocks';
import { TranscriptBlockView } from '../../components/transcript-block-view';
import { ConnectionPill } from '../../components/connection-pill';
import { QuotaSheetTrigger } from '../../components/quota-sheet';
import { ATTENTION_COLOR, SessionStatusDot } from '../../components/session-status-dot';
import { crewMemberSessionAccess } from '../../lib/crew-member-session';
import { deriveNeedsInput, latestSessionStatus } from '../../lib/session-pending-input';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { groupTranscriptBlocks, statusBadgeVariant } from '../../lib/session-ui';
import { canHandoffSession, handoffTargets } from '../../lib/session-handoff';
import { HandoffSheet } from '../../components/handoff-sheet';

export default function SessionDetail() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionId = typeof id === 'string' ? id : null;
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState('');
  const [composerHeight, setComposerHeight] = useState(64);
  const [sending, setSending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [handingOffId, setHandingOffId] = useState<string | null>(null);
  const [pendingHandoff, setPendingHandoff] = useState(false);
  const listRef = useRef<FlatList>(null);
  const actionsRef = useRef<BottomSheetModal>(null);
  const handoffRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => (confirmDelete ? ['38%'] : ['42%']), [confirmDelete]);

  const { events, steer, connectionState } = useSessionTranscript(sessionId);
  const blocks = groupTranscriptBlocks(useTranscriptBlocks(events));
  const access = crewMemberSessionAccess(session);
  const sessionLoaded = session !== null;
  const canRespond = access.canMutate && session?.supportsInteraction === true;
  const needsInput = useMemo(
    () => deriveNeedsInput(events, session?.status, session?.pendingInput),
    [events, session?.status, session?.pendingInput],
  );
  // The event tail is authoritative over the (possibly stale) session row, and
  // only a live RUNNING session is actually awaiting your answer — a pending
  // question on any other status must not raise the amber alarm.
  const sessionRunning = (latestSessionStatus(events) ?? session?.status) === 'RUNNING';

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

  // The engine catalog powers cross-engine handoff targets. fetchModels already
  // swallows transport errors (returns []), so a missing catalog simply hides
  // the handoff action rather than surfacing an error.
  useEffect(() => {
    void fetchModels().then(setProviders).catch(() => {});
  }, []);

  const canHandoff = canHandoffSession(session?.status, access.managedByCrew);
  const handoffTargetList = useMemo(
    () => (canHandoff ? handoffTargets(providers, session?.provider) : []),
    [canHandoff, providers, session?.provider],
  );
  const currentProviderName = session?.provider
    ? providerMeta(session.provider, providers.length ? providers : undefined).name
    : undefined;

  const send = useCallback(async () => {
    const text = message.trim();
    if (!text || sending || !access.canMutate) return;
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
  }, [access.canMutate, message, sending, steer]);

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

  const deleteCurrentSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      await deleteSession(sessionId);
      actionsRef.current?.dismiss();
      router.back();
    } catch {
      setError('Delete failed.');
    }
  }, [router, sessionId]);

  const openActions = useCallback(() => {
    if (!session || !access.canMutate) return;
    setConfirmDelete(false);
    actionsRef.current?.present();
  }, [access.canMutate, session]);

  // Present the handoff sheet only once the actions sheet has fully dismissed —
  // presenting a second modal mid-dismiss races gorhom's modal stack. The
  // pendingHandoff flag is consumed in the actions sheet onDismiss below.
  const openHandoff = useCallback(() => {
    setPendingHandoff(true);
    actionsRef.current?.dismiss();
  }, []);

  const doHandoff = useCallback(
    async (provider: string) => {
      if (!sessionId || handingOffId) return;
      setHandingOffId(provider);
      setError(null);
      try {
        const next = await handoffSessionTo(sessionId, { provider });
        handoffRef.current?.dismiss();
        router.replace(`/session/${next.id}`);
      } catch (err) {
        handoffRef.current?.dismiss();
        const detail = (err as { message?: string })?.message;
        setError(detail || 'Hand off failed.');
      } finally {
        setHandingOffId(null);
      }
    },
    [sessionId, handingOffId, router],
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
      className="flex-1 bg-background"
      style={{ flex: 1 }}
    >
      <View
        className="flex-row items-center gap-3 border-b border-border px-4 pb-3"
        style={{ paddingTop: Math.max(insets.top, 16) }}
      >
        <Pressable
          accessibilityLabel="Back"
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full active:bg-card"
        >
          <ArrowLeft color="#eff0f1" size={21} />
        </Pressable>
        <View className="flex-1 flex-row items-start gap-2">
          {session ? (
            <View className="mt-1.5">
              <SessionStatusDot status={session.status} pendingInput={needsInput} />
            </View>
          ) : null}
          <View className="min-w-0 flex-1">
            <Text className="font-semibold text-foreground" numberOfLines={1}>
              {session?.title || session?.prompt || 'Session'}
            </Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {needsInput ? (
                <Text style={{ color: ATTENTION_COLOR }}>Waiting for you</Text>
              ) : (
                session ? statusLabel(session.status) : '…'
              )}
              {access.managedByCrew ? ' · Managed by Crew' : ''}
            </Text>
          </View>
        </View>
        <QuotaSheetTrigger activeProvider={session?.provider} model={session?.model} />
        <ConnectionPill state={connectionState} />
        {session ? (
          <Badge variant={statusBadgeVariant(session.status)}>
            <UItext>{statusLabel(session.status)}</UItext>
          </Badge>
        ) : null}
        {access.canMutate ? (
          <Pressable
            accessibilityLabel="Session actions"
            onPress={openActions}
            className="h-9 w-9 items-center justify-center rounded-full active:bg-card"
          >
            <MoreHorizontal color="#9ca3af" size={21} />
          </Pressable>
        ) : null}
      </View>

      <FlatList
        ref={listRef}
        className="flex-1 px-3"
        style={{ flex: 1, minHeight: 0 }}
        data={blocks}
        extraData={`${canRespond}:${sessionLoaded}:${sessionRunning}`}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => (
          <TranscriptBlockView
            block={item}
            sessionId={sessionId}
            canRespond={canRespond}
            sessionLoaded={sessionLoaded}
            sessionRunning={sessionRunning}
          />
        )}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View className="items-center px-6 py-16">
            <Text className="text-sm text-muted-foreground">Waiting for the agent transcript…</Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: 12 }}
      />

      {error ? (
        <View className="mx-4 mb-2 flex-row items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2">
          <Text className="flex-1 text-xs text-destructive">{error}</Text>
          <Pressable onPress={() => setError(null)}>
            <Text className="text-xs font-medium text-destructive">Dismiss</Text>
          </Pressable>
        </View>
      ) : null}

      {access.canMutate ? (
        <View
          className="border-t border-border bg-background px-3 pt-2"
          style={{ flexShrink: 0, paddingBottom: Math.max(insets.bottom + 10, 10) }}
        >
          <View className="flex-row items-end gap-2 rounded-xl border border-border bg-card px-2 py-2">
            <Button
              accessibilityLabel="Attach image"
              disabled
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full"
              // TODO: Wire this button to image attachments.
            >
              <Paperclip color="#83868b" size={18} />
            </Button>
            <Textarea
              value={message}
              onChangeText={setMessage}
              placeholder="Steer the agent…"
              placeholderTextColor="#83868b"
              className="min-h-10 flex-1 border-0 bg-transparent px-1 py-2 text-sm shadow-none"
              style={{ height: composerHeight }}
              onContentSizeChange={(event) => {
                const next = Math.min(Math.max(event.nativeEvent.contentSize.height, 40), 128);
                setComposerHeight(next);
              }}
            />
            <Button
              accessibilityLabel={sending ? 'Sending steer' : 'Send steer'}
              disabled={sending || !message.trim()}
              onPress={() => void send()}
              size="icon"
              className="h-9 w-9 rounded-full"
            >
              {sending ? (
                <ActivityIndicator size="small" color="#161719" />
              ) : (
                <Send color="#161719" size={16} strokeWidth={2.2} />
              )}
            </Button>
          </View>
        </View>
      ) : (
        <View className="border-t border-border px-4 py-3 pb-8">
          <Text className="text-sm font-semibold text-foreground">Managed by Crew</Text>
          <Text className="mt-1 text-xs text-muted-foreground">Inspect-only member session</Text>
        </View>
      )}

      <BottomSheetModal
        ref={actionsRef}
        index={0}
        snapPoints={snapPoints}
        enablePanDownToClose
        backdropComponent={(props) => (
          <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} />
        )}
        backgroundStyle={{ backgroundColor: '#18191c' }}
        handleIndicatorStyle={{ backgroundColor: '#606369' }}
        onDismiss={() => {
          setConfirmDelete(false);
          if (pendingHandoff) {
            setPendingHandoff(false);
            handoffRef.current?.present();
          }
        }}
      >
        <BottomSheetView className="flex-1 px-5 pb-8">
          {confirmDelete ? (
            <>
              <Text className="text-lg font-semibold text-foreground">Delete this session?</Text>
              <Text className="mt-2 text-sm leading-5 text-muted-foreground">
                The transcript is gone for good. This cannot be undone.
              </Text>
              <View className="mt-6 flex-row gap-3">
                <Button variant="outline" className="flex-1" onPress={() => setConfirmDelete(false)}>
                  <UItext>Cancel</UItext>
                </Button>
                <Button variant="destructive" className="flex-1" onPress={() => void deleteCurrentSession()}>
                  <Trash2 color="#fff" size={16} />
                  <UItext>Delete</UItext>
                </Button>
              </View>
            </>
          ) : (
            <>
              <Text className="text-lg font-semibold text-foreground">Session actions</Text>
              <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>
                {session?.title || session?.prompt || 'Session'}
              </Text>
              <View className="mt-5 gap-1">
                {canHandoff && handoffTargetList.length > 0 ? (
                  <ActionButton
                    icon={<ArrowRightLeft color="#eff0f1" size={18} />}
                    label="Hand off to another engine"
                    onPress={openHandoff}
                  />
                ) : null}
                {session?.status === 'RUNNING' ? (
                  <ActionButton
                    icon={<Pause color="#eff0f1" size={18} />}
                    label="Pause agent"
                    onPress={() => void runAction(pauseSession, 'Pause')}
                  />
                ) : session?.status === 'PAUSED' ? (
                  <ActionButton icon={<Play color="#83868b" size={18} />} label="Resume via steer" disabled />
                ) : null}
                {session?.status === 'ARCHIVED' ? (
                  <ActionButton
                    icon={<ArchiveRestore color="#eff0f1" size={18} />}
                    label="Restore session"
                    onPress={() => void runAction(restoreSession, 'Restore')}
                  />
                ) : (
                  <ActionButton
                    icon={<Archive color="#eff0f1" size={18} />}
                    label="Archive session"
                    onPress={() => void runAction(archiveSession, 'Archive')}
                  />
                )}
                <ActionButton
                  icon={<Trash2 color="#f5605b" size={18} />}
                  label="Delete permanently"
                  destructive
                  onPress={() => setConfirmDelete(true)}
                />
              </View>
            </>
          )}
        </BottomSheetView>
      </BottomSheetModal>

      <HandoffSheet
        sheetRef={handoffRef}
        targets={handoffTargetList}
        currentProviderName={currentProviderName}
        handingOffId={handingOffId}
        onSelect={(provider) => void doHandoff(provider)}
      />
    </KeyboardAvoidingView>
  );
}

function ActionButton({
  icon,
  label,
  onPress,
  disabled = false,
  destructive = false,
}: {
  icon: React.ReactNode;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      className={`flex-row items-center gap-3 rounded-xl px-3 py-3.5 active:bg-accent ${disabled ? 'opacity-50' : ''}`}
    >
      {icon}
      <Text className={`text-sm font-medium ${destructive ? 'text-destructive' : 'text-foreground'}`}>{label}</Text>
      {disabled ? <Text className="ml-auto text-xs text-muted-foreground">Not available</Text> : null}
    </Pressable>
  );
}
