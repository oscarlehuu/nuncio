import { type LoopDto, type StopCondition } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';
import {
  buildScheduleSpec,
  formatNextFire,
  formatScheduleSpec,
  type ScheduleFormFields,
} from '@nuncio/core/loop-schedule';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ModelPicker } from './model-picker';
import { ScheduleFields } from './loop-schedule-fields';

/** Absolute time — the detail view shows this next to the relative countdown. */
function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });
}

function stopText(stop: StopCondition): string {
  if (!stop) return 'Runs until you pause it';
  if (stop.kind === 'maxTotalRuns') return `Stops after ${stop.n} total runs`;
  return `Stops after ${stop.n} consecutive successful checks`;
}

interface LoopSettingsTabProps {
  loop: LoopDto;
  providers: ModelProvider[];
  name: string;
  onNameChange: (name: string) => void;
  goal: string;
  onGoalChange: (goal: string) => void;
  engine: string | null;
  model: string | null;
  onEngineModelChange: (engine: string | null, model: string | null) => void;
  maxRunsPerDay: number;
  onMaxRunsChange: (n: number) => void;
  /** Editable trigger fields (seeded from the loop's owned schedule). */
  schedule: ScheduleFormFields;
  onScheduleChange: (next: ScheduleFormFields) => void;
  maxConsecutiveFailures: number;
  onMaxFailuresChange: (n: number) => void;
}

/**
 * The Settings tab of a loop's detail page. Editable name + goal + engine override +
 * daily budget + trigger + breaker; only the stop condition and output policy stay
 * read-only. Editing the trigger re-specs the loop's owned schedule in place, so run
 * history and streaks survive. The live preview pairs the human schedule with an
 * absolute next-run time beside the relative countdown so "in 2h" is never ambiguous.
 */
export function LoopSettingsTab({
  loop,
  providers,
  name,
  onNameChange,
  goal,
  onGoalChange,
  engine,
  model,
  onEngineModelChange,
  maxRunsPerDay,
  onMaxRunsChange,
  schedule,
  onScheduleChange,
  maxConsecutiveFailures,
  onMaxFailuresChange,
}: LoopSettingsTabProps) {
  const set = (patch: Partial<ScheduleFormFields>) => onScheduleChange({ ...schedule, ...patch });
  const timeValid =
    schedule.mode === 'interval' || schedule.mode === 'event' || /^\d{1,2}:\d{2}$/.test(schedule.time);
  const intervalValid =
    schedule.mode !== 'interval' || (Number.isInteger(schedule.interval) && schedule.interval > 0);
  const previewSpec = buildScheduleSpec(schedule.mode, schedule);

  return (
    <div className="flex flex-col gap-5">
      <Field label="Name" htmlFor="loop-name-edit">
        <Input
          id="loop-name-edit"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Optional — defaults to the goal"
        />
      </Field>

      {/*
        Goal is a bordered container (Cursor's Agent-Instructions box): a borderless
        textarea with the engine·model picker docked in a footer strip inside the same
        border — the control that configures the goal lives INSIDE its block, not as a
        separate labeled row on the page background.
      */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="loop-goal-edit" className="text-ui font-medium text-foreground">
          Goal
        </label>
        <div
          data-testid="loop-goal-container"
          className="flex flex-col rounded-xl border border-border/70 bg-card transition-shadow focus-within:ring-2 focus-within:ring-ring/40"
        >
          <Textarea
            id="loop-goal-edit"
            value={goal}
            onChange={(e) => onGoalChange(e.target.value)}
            rows={3}
            className="resize-none border-0 bg-transparent px-4 pt-3 pb-2 shadow-none focus-visible:border-0 focus-visible:ring-0"
          />
          <div className="flex items-center gap-2 px-3 pb-2.5 pt-1 [&_button]:shrink-0">
            <ModelPicker
              pairMode="engine+model"
              providers={providers}
              engine={engine}
              model={model}
              onPairChange={onEngineModelChange}
              inheritOption={{ label: 'Inherit from project' }}
              providerDefaultOption
              autoPick={false}
              variant="text"
              compact
            />
          </div>
        </div>
      </div>

      <Field label="Trigger">
        <ScheduleFields
          mode={schedule.mode}
          onModeChange={(mode) => set({ mode })}
          time={schedule.time}
          onTimeChange={(time) => set({ time })}
          interval={schedule.interval}
          onIntervalChange={(interval) => set({ interval })}
          unit={schedule.unit}
          onUnitChange={(unit) => set({ unit })}
          weekday={schedule.weekday}
          onWeekdayChange={(weekday) => set({ weekday })}
          event={schedule.event}
          onEventChange={(event) => set({ event })}
          label={schedule.label}
          onLabelChange={(label) => set({ label })}
          timeValid={timeValid}
          intervalValid={intervalValid}
        />
        <p className="mt-1.5 text-ui-sm text-muted-foreground">
          {timeValid && intervalValid ? formatScheduleSpec(previewSpec) : 'Enter a valid time'}
          {loop.nextFireAt != null && loop.status === 'active' && (
            <span className="block">
              {formatNextFire(loop.nextFireAt)} · {absoluteTime(loop.nextFireAt)}
            </span>
          )}
        </p>
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Runs per day" htmlFor="loop-budget-edit">
          <Input
            id="loop-budget-edit"
            type="number"
            min={1}
            value={maxRunsPerDay}
            onChange={(e) => onMaxRunsChange(Math.max(1, Number(e.target.value) || 1))}
          />
        </Field>
        <Field label="Pause after failures" htmlFor="loop-breaker-edit">
          <Input
            id="loop-breaker-edit"
            type="number"
            min={1}
            aria-label="Consecutive failures before pausing"
            value={maxConsecutiveFailures}
            onChange={(e) => onMaxFailuresChange(Math.max(1, Number(e.target.value) || 1))}
          />
        </Field>
      </div>

      <dl className="grid gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-e0 sm:grid-cols-2">
        <Fact term="Stop condition">{stopText(loop.stop)}</Fact>
        <Fact term="Output">Fresh worktree → pull request</Fact>
      </dl>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-ui font-medium text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ui-sm text-muted-foreground">{term}</dt>
      <dd className="text-ui text-foreground">{children}</dd>
    </div>
  );
}
