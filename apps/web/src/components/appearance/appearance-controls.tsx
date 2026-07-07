import type { ReactNode } from 'react';
import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Label + description on the left, control on the right — the section's row rhythm. */
export function FieldRow({
  title,
  description,
  children,
  htmlFor,
}: {
  title: string;
  description: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-col">
        <label
          htmlFor={htmlFor}
          className="text-ui-lg font-medium text-foreground"
        >
          {title}
        </label>
        <span className="text-ui text-muted-foreground">{description}</span>
      </div>
      {children}
    </div>
  );
}

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/40 p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={cn(
            'rounded-md px-2.5 py-1 text-ui font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === opt.value
              ? 'bg-background text-foreground shadow-e0'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({
  value,
  min,
  max,
  onChange,
  unit = 'px',
  ariaLabel,
  id,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  unit?: string;
  ariaLabel: string;
  id?: string;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-background p-0.5">
      <StepButton
        label={`Decrease ${ariaLabel}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        <Minus className="size-3.5" />
      </StepButton>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        aria-label={ariaLabel}
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(clamp(n));
        }}
        className={cn(
          'w-10 bg-transparent text-center text-ui tabular-nums text-foreground outline-none',
          '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
        )}
      />
      <span className="pr-1 text-ui-sm text-muted-foreground">{unit}</span>
      <StepButton
        label={`Increase ${ariaLabel}`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        <Plus className="size-3.5" />
      </StepButton>
    </div>
  );
}

function StepButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'grid size-6 place-items-center rounded-md text-muted-foreground transition-colors',
        'hover:bg-muted hover:text-foreground active:scale-95',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-30',
      )}
    >
      {children}
    </button>
  );
}

export function FontSelect<T extends string>({
  id,
  value,
  options,
  onChange,
  ariaLabel,
}: {
  id?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(
        'h-7 shrink-0 rounded-md border border-border bg-background px-2 text-ui font-medium text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
