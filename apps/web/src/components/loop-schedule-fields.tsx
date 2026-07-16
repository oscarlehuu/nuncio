import { ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EVENT_CATALOG } from '@nuncio/core/loop-schedule';
import { cn } from '@/lib/utils';

export type ScheduleMode = 'daily' | 'interval' | 'weekday' | 'event';

const MODES: Array<{ value: ScheduleMode; label: string }> = [
  { value: 'daily', label: 'Daily' },
  { value: 'interval', label: 'Interval' },
  { value: 'weekday', label: 'Weekly' },
  { value: 'event', label: 'On event' },
];

const WEEKDAYS: Array<{ value: string; label: string }> = [
  { value: 'mon', label: 'Monday' },
  { value: 'tue', label: 'Tuesday' },
  { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' },
  { value: 'fri', label: 'Friday' },
  { value: 'sat', label: 'Saturday' },
  { value: 'sun', label: 'Sunday' },
];

interface ScheduleFieldsProps {
  mode: ScheduleMode;
  onModeChange: (mode: ScheduleMode) => void;
  time: string;
  onTimeChange: (time: string) => void;
  interval: number;
  onIntervalChange: (n: number) => void;
  unit: 'm' | 'h';
  onUnitChange: (unit: 'm' | 'h') => void;
  weekday: string;
  onWeekdayChange: (weekday: string) => void;
  /** The `<kind>.<action>` webhook event (event mode). */
  event: string;
  onEventChange: (event: string) => void;
  /** Optional label filter the event must carry (event mode). */
  label: string;
  onLabelChange: (label: string) => void;
  timeValid: boolean;
  intervalValid: boolean;
}

/**
 * The schedule half of the create/edit loop form. A segmented control picks the
 * trigger family; the conditional fields below build a spec the server parses.
 * Invalid time/interval is flagged inline (aria-invalid) so a bad spec can't ship.
 * The "On event" family fires the loop from an inbound forge webhook (issue/PR).
 */
export function ScheduleFields({
  mode,
  onModeChange,
  time,
  onTimeChange,
  interval,
  onIntervalChange,
  unit,
  onUnitChange,
  weekday,
  onWeekdayChange,
  event,
  onEventChange,
  label,
  onLabelChange,
  timeValid,
  intervalValid,
}: ScheduleFieldsProps) {
  const weekdayLabel = WEEKDAYS.find((d) => d.value === weekday)?.label ?? 'Monday';
  const eventLabel = EVENT_CATALOG.find((e) => e.value === event)?.label ?? event;

  return (
    <div className="flex flex-col gap-2.5">
      <div role="tablist" aria-label="Schedule type" className="inline-flex gap-1 rounded-lg bg-muted/40 p-1">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="tab"
            aria-selected={mode === m.value}
            onClick={() => onModeChange(m.value)}
            className={cn(
              'rounded-md px-3 py-1 text-ui-lg transition-colors active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              mode === m.value
                ? 'bg-card font-medium text-foreground shadow-e0'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'event' ? (
        <div className="flex flex-col gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-full justify-between px-3"
                aria-label={`Trigger event: ${eventLabel}`}
              >
                <span className="truncate">{eventLabel}</span>
                <ChevronDown className="size-3.5 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
              {EVENT_CATALOG.map((e) => (
                <DropdownMenuItem key={e.value} onClick={() => onEventChange(e.value)}>
                  {e.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-ui text-muted-foreground">with label</span>
            <Input
              aria-label="Required label filter (optional)"
              placeholder="any label"
              value={label}
              onChange={(e) => onLabelChange(e.target.value)}
              className="flex-1"
            />
          </div>
          <p className="text-ui-sm text-muted-foreground">
            Fires when a matching issue or pull request webhook arrives. Leave the label blank to match
            every one.
          </p>
        </div>
      ) : mode === 'interval' ? (
        <div className="flex items-center gap-2">
          <span className="text-ui text-muted-foreground">Every</span>
          <Input
            type="number"
            min={1}
            aria-label="Interval amount"
            aria-invalid={!intervalValid || undefined}
            value={interval}
            onChange={(e) => onIntervalChange(Math.max(1, Number(e.target.value) || 1))}
            className="w-20"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-28 justify-between px-3"
                aria-label={`Interval unit: ${unit === 'h' ? 'hours' : 'minutes'}`}
              >
                <span>{unit === 'h' ? 'hours' : 'minutes'}</span>
                <ChevronDown className="size-3.5 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => onUnitChange('m')}>minutes</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onUnitChange('h')}>hours</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {mode === 'weekday' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 w-36 justify-between px-3"
                  aria-label={`Day of week: ${weekdayLabel}`}
                >
                  <span>{weekdayLabel}</span>
                  <ChevronDown className="size-3.5 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {WEEKDAYS.map((d) => (
                  <DropdownMenuItem key={d.value} onClick={() => onWeekdayChange(d.value)}>
                    {d.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <span className="text-ui text-muted-foreground">at</span>
          <Input
            type="time"
            aria-label="Time of day"
            aria-invalid={!timeValid || undefined}
            value={time}
            onChange={(e) => onTimeChange(e.target.value)}
            className="w-32"
          />
        </div>
      )}
    </div>
  );
}
