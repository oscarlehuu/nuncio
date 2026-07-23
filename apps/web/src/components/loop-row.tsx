import { useState } from 'react';
import { CalendarClock, ChevronDown, ChevronRight, FolderGit2, Pause, Play, Trash2 } from 'lucide-react';
import { relativeTime, type LoopDto, type LoopRunDto } from '../lib/api';
import {
  failureStreak,
  formatNextFire,
  formatScheduleSpec,
  lastExecutedRun,
  loopDisplayName,
  runsToday,
} from '@nuncio/core/loop-schedule';
import { projectDisplayName } from '../lib/projects';
import { checkLabel } from '../lib/loop-check-label';
import { LoopStatusChip, VerifyDot } from './loop-status-chip';
import { LoopRunHistory } from './loop-run-history';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface LoopRowProps {
  loop: LoopDto;
  runs: LoopRunDto[];
  runsLoading?: boolean;
  busy?: boolean;
  /** Open the loop's detail page (row title). Falls back to no-op when absent. */
  onOpen?: () => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (loop: LoopDto) => void;
}

function stopLabel(loop: LoopDto): string | null {
  if (!loop.stop) return null;
  if (loop.stop.kind === 'maxTotalRuns') return `Stops after ${loop.stop.n} runs`;
  return `Stops after ${loop.stop.n} successful checks`;
}

export function LoopRow({
  loop,
  runs,
  runsLoading,
  busy,
  onOpen,
  onPause,
  onResume,
  onDelete,
}: LoopRowProps) {
  const [expanded, setExpanded] = useState(false);

  const title = loopDisplayName(loop);
  const today = runsToday(runs);
  const last = lastExecutedRun(runs);
  const streak = failureStreak(runs);
  const project = projectDisplayName(loop.projectPath);
  const stop = stopLabel(loop);
  const canResume = loop.status === 'paused' || loop.status === 'broken';
  const schedule = loop.schedule?.spec ? formatScheduleSpec(loop.schedule.spec) : null;
  // Only show a countdown for a loop that will actually fire next (active).
  const nextFire = loop.status === 'active' ? formatNextFire(loop.nextFireAt) : null;

  return (
    <li className="rounded-xl border border-border bg-card">
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide run history' : 'Show run history'}
          className="mt-0.5 shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {onOpen ? (
              <button
                type="button"
                onClick={onOpen}
                className="min-w-0 truncate rounded text-left text-ui-lg font-semibold text-foreground transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {title}
              </button>
            ) : (
              <h3 className="truncate text-ui-lg font-semibold text-foreground">{title}</h3>
            )}
            <LoopStatusChip status={loop.status} className="shrink-0" />
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui text-muted-foreground">
            {schedule && (
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="size-3.5 shrink-0" />
                {schedule}
              </span>
            )}
            {project && (
              <span className="inline-flex items-center gap-1">
                <FolderGit2 className="size-3.5 shrink-0" />
                {project}
              </span>
            )}
            <span className="tabular-nums">
              {today}/{loop.maxRunsPerDay} runs today
            </span>
            {stop && <span>{stop}</span>}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm">
            {last ? (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <VerifyDot verify={last.verify} />
                <span>
                  Last run {relativeTime(last.createdAt)} · {checkLabel(last.verify)}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">Not run yet</span>
            )}
            {nextFire && <span className="text-muted-foreground">{nextFire}</span>}
            {loop.status === 'broken' && (
              <span className="font-medium text-warning">
                {streak} failed run{streak === 1 ? '' : 's'} in a row — resume to retry
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {canResume ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2.5"
              disabled={busy}
              onClick={() => onResume(loop.id)}
              aria-label={loop.status === 'broken' ? `Fix and resume ${title}` : `Resume ${title}`}
            >
              <Play className="size-3.5" />
              <span className="hidden sm:inline">{loop.status === 'broken' ? 'Fix & resume' : 'Resume'}</span>
            </Button>
          ) : loop.status === 'active' ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2.5"
              disabled={busy}
              onClick={() => onPause(loop.id)}
              aria-label={`Pause ${title}`}
            >
              <Pause className="size-3.5" />
              <span className="hidden sm:inline">Pause</span>
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-8 text-muted-foreground hover:text-destructive"
            disabled={busy}
            onClick={() => onDelete(loop)}
            aria-label={`Delete ${title}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <div className="border-t border-border/60 px-4 py-3">
            <LoopRunHistory runs={runs} loading={runsLoading} />
          </div>
        </div>
      </div>
    </li>
  );
}
