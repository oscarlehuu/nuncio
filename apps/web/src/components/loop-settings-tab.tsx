import { type LoopDto, type StopCondition } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';
import { formatNextFire, formatScheduleSpec } from '@nuncio/core/loop-schedule';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LoopEngineModelPicker } from './loop-engine-model-picker';

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
  return `Stops after ${stop.n} consecutive green verifies`;
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
}

/**
 * The Settings tab of a loop's detail page. Editable name + goal + engine override +
 * daily budget; read-only trigger/stop/breaker facts (changing a schedule is a rarer
 * op, deferred). The trigger line pairs the human schedule with an absolute next-run
 * time beside the relative countdown so "in 2h" is never ambiguous.
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
}: LoopSettingsTabProps) {
  const schedule = loop.schedule?.spec ? formatScheduleSpec(loop.schedule.spec) : 'No schedule';

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

      <Field label="Goal" htmlFor="loop-goal-edit">
        <Textarea
          id="loop-goal-edit"
          value={goal}
          onChange={(e) => onGoalChange(e.target.value)}
          rows={3}
          className="resize-none"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui font-medium text-foreground">Engine</span>
        <LoopEngineModelPicker
          providers={providers}
          engine={engine}
          model={model}
          onChange={onEngineModelChange}
        />
      </div>

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
      </div>

      <dl className="grid gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-e0 sm:grid-cols-2">
        <Fact term="Trigger">
          {schedule}
          {loop.nextFireAt != null && loop.status === 'active' && (
            <span className="block text-ui-sm text-muted-foreground">
              {formatNextFire(loop.nextFireAt)} · {absoluteTime(loop.nextFireAt)}
            </span>
          )}
        </Fact>
        <Fact term="Stop condition">{stopText(loop.stop)}</Fact>
        <Fact term="Breaker">Pauses after {loop.maxConsecutiveFailures} failures in a row</Fact>
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
