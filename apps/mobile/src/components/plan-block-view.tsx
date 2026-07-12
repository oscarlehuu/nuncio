import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PlanItem } from '@nuncio/core/plan.types';
import { planProgress } from '@nuncio/core/plan.types';

const MARK: Record<PlanItem['status'], string> = {
  done: '✓',
  in_progress: '●',
  pending: '○',
};

/**
 * Collapsed "Plan · n/m done · active step" row that expands to the checklist.
 * Mono only — a plan is ambient progress, never an attention cue.
 */
export function PlanBlockView({ items }: { items: PlanItem[] }) {
  const [open, setOpen] = useState(false);
  const { done, total } = planProgress(items);
  const active = items.find((item) => item.status === 'in_progress');

  return (
    <View className="my-1">
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Plan, ${done} of ${total} steps done`}
        className="min-h-9 flex-row items-center gap-2 px-1 active:opacity-60"
      >
        <Text className="text-xs text-muted-foreground">
          Plan · {done}/{total} done
        </Text>
        {!open && active ? (
          <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
            · {active.text}
          </Text>
        ) : (
          <View className="flex-1" />
        )}
        <Text
          className="text-xs text-muted-foreground"
          style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
        >
          ›
        </Text>
      </Pressable>
      {open ? (
        <View className="gap-1.5 pb-1 pl-1 pt-1.5">
          {items.map((item) => (
            <View key={item.id} className="flex-row items-start gap-2">
              <Text
                className={`text-xs leading-5 ${
                  item.status === 'in_progress' ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                {MARK[item.status]}
              </Text>
              <Text
                className={`flex-1 text-sm leading-5 ${
                  item.status === 'done'
                    ? 'text-muted-foreground line-through'
                    : item.status === 'in_progress'
                      ? 'font-medium text-foreground'
                      : 'text-foreground'
                }`}
              >
                {item.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
