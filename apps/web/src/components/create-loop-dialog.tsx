import { useState } from 'react';
import { toast } from 'sonner';
import {
  createLoop,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_RUNS_PER_DAY,
  type CreateLoopInput,
  type LoopDto,
  type StopCondition,
} from '../lib/api';
import { buildScheduleSpec, formatScheduleSpec } from '@nuncio/core/loop-schedule';
import { ProjectPicker } from './project-picker';
import { ScheduleFields, type ScheduleMode } from './loop-schedule-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChevronDown } from 'lucide-react';

type StopKind = 'standing' | 'maxTotalRuns' | 'verifyGreenN';

const STOP_LABELS: Record<StopKind, string> = {
  standing: 'Run until I pause it',
  maxTotalRuns: 'Stop after N total runs',
  verifyGreenN: 'Stop after N green verifies',
};

interface CreateLoopDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (loop: LoopDto) => void;
}

export function CreateLoopDialog({ open, onOpenChange, onCreated }: CreateLoopDialogProps) {
  const [goal, setGoal] = useState('');
  const [projectPath, setProjectPath] = useState<string>('');
  const [mode, setMode] = useState<ScheduleMode>('daily');
  const [time, setTime] = useState('22:00');
  const [interval, setInterval] = useState(6);
  const [unit, setUnit] = useState<'m' | 'h'>('h');
  const [weekday, setWeekday] = useState('mon');
  const [maxRunsPerDay, setMaxRunsPerDay] = useState(DEFAULT_MAX_RUNS_PER_DAY);
  const [stopKind, setStopKind] = useState<StopKind>('standing');
  const [stopN, setStopN] = useState(5);
  const [submitting, setSubmitting] = useState(false);

  const timeValid = mode === 'interval' || /^\d{1,2}:\d{2}$/.test(time);
  const intervalValid = mode !== 'interval' || (Number.isInteger(interval) && interval > 0);
  const goalValid = goal.trim().length > 0;
  const stopValid = stopKind === 'standing' || (Number.isInteger(stopN) && stopN > 0);
  const canSubmit = goalValid && timeValid && intervalValid && stopValid && !submitting;

  const spec = buildScheduleSpec(mode, { time, interval, unit, weekday });

  const reset = () => {
    setGoal('');
    setProjectPath('');
    setMode('daily');
    setTime('22:00');
    setInterval(6);
    setUnit('h');
    setWeekday('mon');
    setMaxRunsPerDay(DEFAULT_MAX_RUNS_PER_DAY);
    setStopKind('standing');
    setStopN(5);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const buildStop = (): StopCondition => {
    if (stopKind === 'maxTotalRuns') return { kind: 'maxTotalRuns', n: stopN };
    if (stopKind === 'verifyGreenN') return { kind: 'verifyGreenN', n: stopN };
    return null;
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const input: CreateLoopInput = {
      goal: goal.trim(),
      schedule: { kind: 'cron', spec },
      maxRunsPerDay,
      maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
      stop: buildStop(),
      ...(projectPath ? { projectPath } : {}),
    };
    try {
      const loop = await createLoop(input);
      toast.success('Loop created');
      reset();
      onCreated(loop);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create loop');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New loop</DialogTitle>
          <DialogDescription>
            A standing task nuncio runs on a schedule, inside a daily budget, landing each result as a
            pull request.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label="Goal" htmlFor="loop-goal">
            <Textarea
              id="loop-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Triage new issues labeled agent and open a fix PR"
              rows={3}
              className="resize-none"
            />
          </Field>

          <Field label="Project">
            <ProjectPicker value={projectPath} onChange={setProjectPath} />
          </Field>

          <Field label="Schedule">
            <ScheduleFields
              mode={mode}
              onModeChange={setMode}
              time={time}
              onTimeChange={setTime}
              interval={interval}
              onIntervalChange={setInterval}
              unit={unit}
              onUnitChange={setUnit}
              weekday={weekday}
              onWeekdayChange={setWeekday}
              timeValid={timeValid}
              intervalValid={intervalValid}
            />
            <p className="mt-1.5 text-ui-sm text-muted-foreground">
              {timeValid && intervalValid ? formatScheduleSpec(spec) : 'Enter a valid time'}
            </p>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Runs per day" htmlFor="loop-budget">
              <Input
                id="loop-budget"
                type="number"
                min={1}
                value={maxRunsPerDay}
                onChange={(e) => setMaxRunsPerDay(Math.max(1, Number(e.target.value) || 1))}
              />
            </Field>
            <Field label="Pause after failures">
              <div className="flex h-9 items-center rounded-md border border-border bg-muted/30 px-3 text-ui text-muted-foreground">
                {DEFAULT_MAX_CONSECUTIVE_FAILURES} in a row
              </div>
            </Field>
          </div>

          <Field label="Stop condition">
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 flex-1 justify-between px-3">
                    <span className="truncate">{STOP_LABELS[stopKind]}</span>
                    <ChevronDown className="size-3.5 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
                  {(Object.keys(STOP_LABELS) as StopKind[]).map((kind) => (
                    <DropdownMenuItem key={kind} onClick={() => setStopKind(kind)}>
                      {STOP_LABELS[kind]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {stopKind !== 'standing' && (
                <Input
                  type="number"
                  min={1}
                  aria-label="Stop threshold"
                  value={stopN}
                  onChange={(e) => setStopN(Math.max(1, Number(e.target.value) || 1))}
                  className="w-20"
                />
              )}
            </div>
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? 'Creating…' : 'Create loop'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-ui font-medium text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
