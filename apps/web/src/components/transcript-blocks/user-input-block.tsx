import { ChevronDown } from 'lucide-react';
import { memo, useState } from 'react';
import { cn } from '@/lib/utils';
import type { UserInputQuestion, UserInputResolvedBy } from '@/lib/user-input.types';

export interface UserInputBlockProps {
  requestId: string;
  title?: string;
  questions: UserInputQuestion[];
  resolvedBy?: UserInputResolvedBy;
  defaultOpen?: boolean;
}

function resolvedLabel(resolvedBy?: UserInputResolvedBy): string | null {
  if (resolvedBy === 'skip') return 'Skipped';
  if (resolvedBy === 'timeout') return 'Timed out';
  return null;
}

export const UserInputBlock = memo(function UserInputBlock({
  requestId,
  title,
  questions,
  resolvedBy,
  defaultOpen = false,
}: UserInputBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const count = questions.length;
  const label = count === 1 ? 'Asked 1 question' : `Asked ${count} questions`;
  const statusLabel = resolvedLabel(resolvedBy);

  return (
    <div className="rounded-md" data-testid={`user-input-block-${requestId}`}>
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 px-1 py-0.5 min-h-[20px] text-left text-muted-foreground"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="user-input-summary"
      >
        <span className="text-[12.5px]">{label}</span>
        {statusLabel && (
          <span className="text-[11px] text-muted-foreground/70">· {statusLabel}</span>
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
        <div className="pl-1 pr-0.5 pb-2 flex flex-col gap-3">
          {title && (
            <p className="text-[13px] font-medium text-foreground/90">{title}</p>
          )}
          {questions.map((question) => (
            <div key={question.id} className="flex flex-col gap-1.5">
              {question.header && (
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {question.header}
                </span>
              )}
              <p className="text-[13px] text-foreground/90">{question.prompt}</p>
              <ul className="flex flex-col gap-1.5">
                {question.options.map((option) => (
                  <li
                    key={option.id}
                    className="rounded-md border border-border/40 bg-muted/15 px-2.5 py-2 min-h-[32px]"
                  >
                    <span className="text-[13px] text-foreground">{option.label}</span>
                    {option.description && (
                      <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                        {option.description}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
