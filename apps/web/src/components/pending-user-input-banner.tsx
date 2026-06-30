import { memo, useEffect, useState } from 'react';
import type { InteractionResponse, PendingUserInput } from '@/lib/user-input.types';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface PendingUserInputBannerProps {
  pending: PendingUserInput[];
  providerLabel?: string;
  supported?: boolean;
  onRespond?: (requestId: string, response: InteractionResponse) => void | Promise<void>;
}

type AnswersByRequest = Record<string, Record<string, string[]>>;

function toggleSelection(
  prev: AnswersByRequest,
  requestId: string,
  questionId: string,
  optionId: string,
  allowMultiple?: boolean,
): AnswersByRequest {
  const bucket = { ...(prev[requestId] ?? {}) };
  const existing = bucket[questionId] ?? [];
  if (allowMultiple) {
    bucket[questionId] = existing.includes(optionId)
      ? existing.filter((id) => id !== optionId)
      : [...existing, optionId];
  } else {
    bucket[questionId] = [optionId];
  }
  return { ...prev, [requestId]: bucket };
}

export const PendingUserInputBanner = memo(function PendingUserInputBanner({
  pending,
  providerLabel = 'this',
  supported = false,
  onRespond,
}: PendingUserInputBannerProps) {
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answersByRequest, setAnswersByRequest] = useState<AnswersByRequest>({});

  const current = pending.find((item) => item.requestId === activeRequestId) ?? pending[0];
  const activeId = current?.requestId;

  useEffect(() => {
    if (!current) return;
    if (activeRequestId !== current.requestId) {
      setActiveRequestId(current.requestId);
      setQuestionIndex(0);
    }
  }, [activeRequestId, current]);

  if (pending.length === 0 || !current || !activeId) return null;
  const question = current.questions[questionIndex];
  const totalQuestions = current.questions.length;
  const selectedForQuestion = answersByRequest[activeId]?.[question?.id ?? ''] ?? [];
  const hasSelection = selectedForQuestion.length > 0;

  const toggleOption = (questionId: string, optionId: string, allowMultiple?: boolean) => {
    if (!supported) return;
    setAnswersByRequest((prev) =>
      toggleSelection(prev, activeId, questionId, optionId, allowMultiple),
    );
  };

  const submit = () => {
    if (!supported || !onRespond) return;
    const answers = Object.entries(answersByRequest[activeId] ?? {}).map(
      ([questionId, selectedOptionIds]) => ({ questionId, selectedOptionIds }),
    );
    void onRespond(activeId, { answers, resolvedBy: 'user' });
  };

  const skip = () => {
    if (!supported || !onRespond) return;
    void onRespond(activeId, { answers: [], resolvedBy: 'skip' });
  };

  return (
    <TooltipProvider>
      <div
        className="mb-2 rounded-lg border border-border/60 bg-card/80 px-3 py-3"
        data-testid="pending-user-input-banner"
      >
        {current.title && (
          <p className="mb-2 text-[13px] font-medium text-foreground">{current.title}</p>
        )}
        {totalQuestions > 1 && (
          <p className="mb-2 text-[11px] text-muted-foreground">
            Question {questionIndex + 1} of {totalQuestions}
          </p>
        )}
        {question && (
          <div className="flex flex-col gap-2">
            {question.header && (
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {question.header}
              </span>
            )}
            <p className="text-[13px] text-foreground">{question.prompt}</p>
            <div className="flex flex-col gap-1.5" role="listbox" aria-label={question.prompt}>
              {question.options.map((option) => {
                const selected = selectedForQuestion.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-pressed={selected}
                    disabled={!supported}
                    onClick={() => toggleOption(question.id, option.id, question.allowMultiple)}
                    className={cn(
                      'rounded-md border px-3 py-2.5 min-h-[40px] text-left transition-colors',
                      selected
                        ? 'border-primary/60 bg-primary/10 ring-1 ring-primary/30'
                        : 'border-border/50 bg-muted/20 hover:bg-muted/35',
                      !supported && 'opacity-70 cursor-not-allowed hover:bg-muted/20',
                    )}
                  >
                    <span className="text-[13px] text-foreground">{option.label}</span>
                    {option.description && (
                      <span className="mt-0.5 block text-[12px] text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          {questionIndex > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!supported}
              onClick={() => setQuestionIndex((i) => Math.max(0, i - 1))}
            >
              Back
            </Button>
          )}
          {questionIndex < totalQuestions - 1 ? (
            <Button
              type="button"
              size="sm"
              disabled={!supported || !hasSelection}
              onClick={() => setQuestionIndex((i) => Math.min(totalQuestions - 1, i + 1))}
            >
              Next
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!supported || !hasSelection}
                    onClick={submit}
                  >
                    Submit
                  </Button>
                </span>
              </TooltipTrigger>
              {!supported && (
                <TooltipContent>
                  Answering from phone is not yet supported for the {providerLabel} provider
                </TooltipContent>
              )}
            </Tooltip>
          )}
          {supported && (
            <Button type="button" variant="ghost" size="sm" onClick={skip}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
});
