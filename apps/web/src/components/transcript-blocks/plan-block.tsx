import { Check, ChevronDown, Circle, CircleDot } from 'lucide-react';
import { memo, useState } from 'react';
import { cn } from '@/lib/utils';
import type { PlanItem } from '@nuncio/core/plan.types';
import { planProgress } from '@nuncio/core/plan.types';

export interface PlanBlockProps {
  items: PlanItem[];
  defaultOpen?: boolean;
}

function StatusIcon({ status }: { status: PlanItem['status'] }) {
  if (status === 'done') return <Check className="size-3.5 shrink-0" aria-hidden />;
  if (status === 'in_progress')
    return <CircleDot className="size-3.5 shrink-0 text-foreground" aria-hidden />;
  return <Circle className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />;
}

export const PlanBlock = memo(function PlanBlock({ items, defaultOpen = false }: PlanBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const { done, total } = planProgress(items);
  const active = items.find((item) => item.status === 'in_progress');

  return (
    <div className="rounded-md" data-testid="plan-block">
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 px-1 py-0.5 min-h-[20px] text-left text-muted-foreground"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="plan-summary"
      >
        <span className="text-ui">
          Plan · {done}/{total} done
        </span>
        {!open && active && (
          <span className="truncate text-ui-sm text-muted-foreground/70">· {active.text}</span>
        )}
        <span className="ml-auto">
          <ChevronDown
            className={cn(
              'size-3 text-muted-foreground/50 transition-transform group-hover:text-muted-foreground',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </span>
      </button>
      {open && (
        <ul className="pl-1 pr-0.5 pb-2 flex flex-col gap-1">
          {items.map((item) => (
            <li
              key={item.id}
              data-status={item.status}
              className="flex items-start gap-2 rounded-md px-1.5 py-1"
            >
              <span className="mt-0.5">
                <StatusIcon status={item.status} />
              </span>
              <span
                className={cn(
                  'text-ui-lg',
                  item.status === 'done' && 'text-muted-foreground line-through decoration-muted-foreground/40',
                  item.status === 'in_progress' && 'text-foreground font-medium',
                  item.status === 'pending' && 'text-foreground/80',
                )}
              >
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
