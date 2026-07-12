import { Check, CircleHelp } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import type { InteractionResponse, PendingUserInput } from '@/lib/user-input.types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
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

interface QuestionDraft {
  selectedOptionIds: string[];
  freeText: string;
  freeTextOpen: boolean;
}

type DraftsByRequest = Record<string, Record<string, QuestionDraft>>;

const EMPTY_DRAFT: QuestionDraft = { selectedOptionIds: [], freeText: '', freeTextOpen: false };

function draftFor(drafts: DraftsByRequest, requestId: string, questionId: string): QuestionDraft {
  return drafts[requestId]?.[questionId] ?? EMPTY_DRAFT;
}

function isAnswered(draft: QuestionDraft): boolean {
  return draft.selectedOptionIds.length > 0 || draft.freeText.trim().length > 0;
}

export const PendingUserInputBanner = memo(function PendingUserInputBanner({
  pending,
  providerLabel = 'The agent',
  supported = false,
  onRespond,
}: PendingUserInputBannerProps) {
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [drafts, setDrafts] = useState<DraftsByRequest>({});
  const [submitting, setSubmitting] = useState(false);

  const current = pending.find((item) => item.requestId === activeRequestId) ?? pending[0];
  const activeId = current?.requestId;

  useEffect(() => {
    if (!current) return;
    if (activeRequestId !== current.requestId) {
      setActiveRequestId(current.requestId);
      setQuestionIndex(0);
      setSubmitting(false);
    }
  }, [activeRequestId, current]);

  if (pending.length === 0 || !current || !activeId) return null;

  const questions = current.questions;
  const question = questions[Math.min(questionIndex, questions.length - 1)];
  if (!question) return null;
  const answeredCount = questions.filter((q) => isAnswered(draftFor(drafts, activeId, q.id))).length;
  const allAnswered = answeredCount === questions.length;
  const draft = draftFor(drafts, activeId, question.id);

  const updateDraft = (questionId: string, update: (prev: QuestionDraft) => QuestionDraft) => {
    if (!supported) return;
    setDrafts((prev) => {
      const bucket = prev[activeId] ?? {};
      const next = update(bucket[questionId] ?? EMPTY_DRAFT);
      return { ...prev, [activeId]: { ...bucket, [questionId]: next } };
    });
  };

  const advanceFrom = (index: number) => {
    const nextUnanswered = questions.findIndex(
      (q, i) => i > index && !isAnswered(draftFor(drafts, activeId, q.id)),
    );
    if (nextUnanswered >= 0) setQuestionIndex(nextUnanswered);
    else if (index < questions.length - 1) setQuestionIndex(index + 1);
  };

  const toggleOption = (optionId: string) => {
    updateDraft(question.id, (prev) => {
      const selected = prev.selectedOptionIds.includes(optionId);
      if (question.allowMultiple) {
        return {
          ...prev,
          selectedOptionIds: selected
            ? prev.selectedOptionIds.filter((id) => id !== optionId)
            : [...prev.selectedOptionIds, optionId],
        };
      }
      // Keep any free text — it becomes a note attached to the selection.
      return { ...prev, selectedOptionIds: selected ? [] : [optionId] };
    });
    if (!question.allowMultiple) advanceFrom(questionIndex);
  };

  const submit = async () => {
    if (!supported || !onRespond || !allAnswered || submitting) return;
    const answers = questions.map((q) => {
      const d = draftFor(drafts, activeId, q.id);
      const freeText = d.freeText.trim();
      return {
        questionId: q.id,
        selectedOptionIds: d.selectedOptionIds,
        ...(freeText ? { freeText } : {}),
      };
    });
    setSubmitting(true);
    try {
      await onRespond(activeId, { answers, resolvedBy: 'user' });
    } finally {
      setSubmitting(false);
    }
  };

  const skip = () => {
    if (!supported || !onRespond || submitting) return;
    void onRespond(activeId, { answers: [], resolvedBy: 'skip' });
  };

  return (
    <TooltipProvider>
      <div
        className="mb-2 rounded-2xl border border-warning/50 bg-card px-4 py-3.5 shadow-e2 surface-lit"
        data-testid="pending-user-input-banner"
      >
        <div className="flex items-center gap-2">
          <CircleHelp className="size-4 text-warning shrink-0" aria-hidden />
          <p className="text-ui-lg font-medium text-foreground">
            {current.title ?? `${providerLabel} needs your input`}
          </p>
          {questions.length > 1 && (
            <span
              className="ml-auto text-ui-sm text-muted-foreground"
              data-testid="user-input-progress"
            >
              {answeredCount}/{questions.length} answered
            </span>
          )}
        </div>

        {questions.length > 1 && (
          <div
            className="mt-2.5 flex flex-wrap items-center gap-1.5"
            role="tablist"
            aria-label="Questions"
          >
            {questions.map((q, index) => {
              const answered = isAnswered(draftFor(drafts, activeId, q.id));
              const active = index === questionIndex;
              return (
                <button
                  key={q.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setQuestionIndex(index)}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-2.5 py-1 text-ui-sm transition-colors',
                    active
                      ? 'border-foreground/50 bg-muted/50 text-foreground'
                      : 'border-border/50 text-muted-foreground hover:bg-muted/30',
                  )}
                >
                  {answered && <Check className="size-3" aria-hidden />}
                  {q.header ?? `Question ${index + 1}`}
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-3 flex flex-col gap-2">
          {questions.length === 1 && question.header && (
            <span className="text-ui-sm uppercase tracking-wide text-muted-foreground">
              {question.header}
            </span>
          )}
          <p className="text-ui-lg text-foreground">{question.prompt}</p>
          <div className="flex flex-col gap-1.5" role="listbox" aria-label={question.prompt}>
            {question.options.map((option, optionIndex) => {
              const selected = draft.selectedOptionIds.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={!supported}
                  onClick={() => toggleOption(option.id)}
                  className={cn(
                    'rounded-md border px-3 py-2.5 min-h-[40px] text-left transition-colors',
                    selected
                      ? 'border-foreground/50 bg-muted/50'
                      : 'border-border/50 bg-muted/15 hover:bg-muted/35',
                    !supported && 'opacity-70 cursor-not-allowed hover:bg-muted/15',
                  )}
                >
                  <span className="flex items-center gap-2 text-ui-lg text-foreground">
                    <span
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded border text-ui-sm',
                        selected
                          ? 'border-foreground/60 text-foreground'
                          : 'border-border/60 text-muted-foreground',
                      )}
                      aria-hidden
                    >
                      {selected ? <Check className="size-3" /> : optionIndex + 1}
                    </span>
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block pl-7 text-ui text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </button>
              );
            })}
            <button
              type="button"
              disabled={!supported}
              data-testid="user-input-other"
              onClick={() =>
                updateDraft(question.id, (prev) => ({ ...prev, freeTextOpen: !prev.freeTextOpen }))
              }
              className={cn(
                'rounded-md border border-dashed px-3 py-2.5 min-h-[40px] text-left transition-colors',
                draft.freeTextOpen || draft.freeText.trim()
                  ? 'border-foreground/50 bg-muted/50'
                  : 'border-border/50 bg-transparent hover:bg-muted/25',
                !supported && 'opacity-70 cursor-not-allowed',
              )}
            >
              <span className="text-ui-lg text-foreground">
                {draft.selectedOptionIds.length > 0 ? 'Add a note…' : 'Other…'}
              </span>
              <span className="mt-0.5 block text-ui text-muted-foreground">
                {draft.selectedOptionIds.length > 0
                  ? 'Extra detail sent with your choice'
                  : 'Type your own answer'}
              </span>
            </button>
          </div>
          {draft.freeTextOpen && (
            <Textarea
              autoFocus
              value={draft.freeText}
              disabled={!supported}
              placeholder={
                draft.selectedOptionIds.length > 0 ? 'Note for your choice…' : 'Your answer…'
              }
              data-testid="user-input-free-text-input"
              onChange={(e) =>
                updateDraft(question.id, (prev) => ({ ...prev, freeText: e.target.value }))
              }
              className="min-h-[64px]"
            />
          )}
        </div>

        <div className="mt-3.5 flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  size="sm"
                  disabled={!supported || !allAnswered || submitting}
                  onClick={() => void submit()}
                >
                  Submit
                </Button>
              </span>
            </TooltipTrigger>
            {!supported && (
              <TooltipContent>
                Answering is not yet supported for the {providerLabel} provider
              </TooltipContent>
            )}
          </Tooltip>
          {supported && (
            <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={skip}>
              Skip
            </Button>
          )}
          {!allAnswered && questions.length > 1 && (
            <span className="text-ui-sm text-muted-foreground">
              Answer all questions to submit
            </span>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
});
