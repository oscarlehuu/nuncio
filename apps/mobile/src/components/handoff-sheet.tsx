import type { RefObject } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import type { ModelProvider } from '@nuncio/core/model-providers';
import { Text } from './ui/text';
import { ProviderIcon, brandForProvider } from './provider-icon';

interface HandoffSheetProps {
  sheetRef: RefObject<BottomSheetModal | null>;
  targets: ModelProvider[];
  currentProviderName?: string;
  /** Provider id of an in-flight handoff, or null when idle. */
  handingOffId: string | null;
  onSelect: (providerId: string) => void;
}

/**
 * Bottom sheet that lists engines the current session may be handed off to.
 * The scrollable is the DIRECT child of the modal (never wrapped in a flex-1
 * BottomSheetView) with an explicit snap point + topInset + disabled dynamic
 * sizing — the layout combination gorhom needs to size the sheet reliably.
 */
export function HandoffSheet({
  sheetRef,
  targets,
  currentProviderName,
  handingOffId,
  onSelect,
}: HandoffSheetProps) {
  const insets = useSafeAreaInsets();
  const busy = handingOffId !== null;
  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={['55%']}
      topInset={insets.top}
      enableDynamicSizing={false}
      enablePanDownToClose
      backdropComponent={(props) => (
        <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} />
      )}
      backgroundStyle={{ backgroundColor: '#18191c' }}
      handleIndicatorStyle={{ backgroundColor: '#606369' }}
    >
      <BottomSheetScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 24,
        }}
      >
        <Text className="text-lg font-semibold text-foreground">Hand off to another engine</Text>
        <Text className="mt-1 text-xs text-muted-foreground">
          Continue this session&apos;s work on a different engine
          {currentProviderName ? `, not ${currentProviderName}` : ''}.
        </Text>
        <View className="mt-4 gap-2">
          {targets.map((target) => {
            const inFlight = handingOffId === target.id;
            return (
              <Pressable
                key={target.id}
                accessibilityRole="button"
                accessibilityLabel={`Hand off to ${target.name}`}
                disabled={busy}
                onPress={() => onSelect(target.id)}
                className={`min-h-14 flex-row items-center gap-3 rounded-xl border border-border bg-card px-3 py-3 active:bg-accent ${busy && !inFlight ? 'opacity-50' : ''}`}
              >
                <View className="h-9 w-9 items-center justify-center rounded-lg bg-secondary">
                  <ProviderIcon brand={brandForProvider(target.id)} size={18} color="#eff0f1" />
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="font-medium text-foreground" numberOfLines={1}>
                    {target.name}
                  </Text>
                  {target.sub ? (
                    <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
                      {target.sub}
                    </Text>
                  ) : null}
                </View>
                {inFlight ? <ActivityIndicator size="small" color="#83868b" /> : null}
              </Pressable>
            );
          })}
        </View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
