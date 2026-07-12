import { Check, ChevronDown } from 'lucide-react';
import { memo, useState } from 'react';
import { cn } from '@/lib/utils';
import type {
  UserInputAnswer,
  UserInputQuestion,
  UserInputResolvedBy,
} from '@/lib/user-input.types';

export interface UserInputBlockProps {
  requestId: string;
  title?: string;
  questions: UserInputQuestion[];
  resolvedBy?: UserInputResolvedBy;
  answers?: UserInputAnswer[];
  defaultOpen?: boolean;
}

function summaryLabel(count: number, resolvedBy?: UserInputResolvedBy): string {
  if (resolvedBy === 'skip') return count === 1 ? 'Question skipped' : 'Questions skipped';
  if (resolvedBy === 'timeout') return count === 1 ? 'Question timed out' : 'Questions timed out';
  if (resolvedBy) return count === 1 ? 'Answered 1 question' : `Answered ${count} questions`;
  return count === 1 ? 'Asked 1 question' : `Asked ${count} questions`;
}

export const UserInputBlock = memo(function UserInputBlock({
  requestId,
  title,
  questions,
  resolvedBy,
  answers,
  defaultOpen = false,
}: UserInputBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const answerFor = (questionId: string) =>
    answers?.find((answer) => answer.questionId === questionId);

  return (
    <div className="rounded-md" data-testid={`user-input-block-${requestId}`}>
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 px-1 py-0.5 min-h-[20px] text-left text-muted-foreground"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="user-input-summary"
      >
        {!resolvedBy && (
          <span className="size-1.5 rounded-full bg-warning shrink-0" aria-hidden />
        )}
        <span className="text-ui">{summaryLabel(questions.length, resolvedBy)}</span>
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
          {title && <p className="text-ui-lg font-medium text-foreground/90">{title}</p>}
          {questions.map((question) => {
            const answer = answerFor(question.id);
            const selectedIds = new Set(answer?.selectedOptionIds ?? []);
            const freeText = answer?.freeText?.trim();
            return (
              <div key={question.id} className="flex flex-col gap-1.5">
                {question.header && (
                  <span className="text-ui-sm uppercase tracking-wide text-muted-foreground">
                    {question.header}
                  </span>
                )}
                <p className="text-ui-lg text-foreground/90">{question.prompt}</p>
                <ul className="flex flex-col gap-1.5">
                  {question.options.map((option, optionIndex) => {
                    const selected = selectedIds.has(option.id);
                    return (
                      <li
                        key={option.id}
                        data-selected={selected || undefined}
                        className={cn(
                          'rounded-md border px-2.5 py-2 min-h-[32px]',
                          selected
                            ? 'border-foreground/40 bg-muted/40'
                            : 'border-border/40 bg-muted/15',
                        )}
                      >
                        <span className="flex items-center gap-2 text-ui-lg text-foreground">
                          <span
                            className={cn(
                              'flex size-4.5 shrink-0 items-center justify-center rounded border text-ui-sm',
                              selected
                                ? 'border-foreground/50 text-foreground'
                                : 'border-border/50 text-muted-foreground',
                            )}
                            aria-hidden
                          >
                            {selected ? <Check className="size-3" /> : optionIndex + 1}
                          </span>
                          {option.label}
                        </span>
                        {option.description && (
                          <p className="mt-0.5 pl-6.5 text-ui leading-snug text-muted-foreground">
                            {option.description}
                          </p>
                        )}
                      </li>
                    );
                  })}
                  {freeText && (
                    <li
                      data-testid="user-input-free-text"
                      className="rounded-md border border-foreground/40 bg-muted/40 px-2.5 py-2 min-h-[32px]"
                    >
                      <span className="flex items-center gap-1.5 text-ui-lg text-foreground">
                        <Check className="size-3.5 shrink-0" aria-hidden />
                        {freeText}
                      </span>
                      <p className="mt-0.5 text-ui leading-snug text-muted-foreground">
                        {selectedIds.size > 0 ? 'Note' : 'Custom answer'}
                      </p>
                    </li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
