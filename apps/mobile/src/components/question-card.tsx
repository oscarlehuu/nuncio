import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { respondInteraction } from '@nuncio/core/api';
import type { TranscriptBlock } from '@nuncio/core/transcript-build-blocks';
import type { UserInputAnswer, UserInputQuestion } from '@nuncio/core/user-input.types';
import {
  allAnswered,
  buildAnswers,
  optionBadge,
  questionAnswered,
  shouldAutoAdvance,
  toggleOption,
  type NoteMap,
  type SelectionMap,
} from '../lib/question-card-state';

// The one non-mono colour in the transcript: a blocked question is the only
// thing here that needs the user, and amber is this app's needs-attention hue
// (see the BLOCKED_USER status dot). Everything resolved reverts to mono.
const AMBER = '#f59e0b';

type UserInputBlock = Extract<TranscriptBlock, { kind: 'user_input' }>;

interface QuestionCardProps {
  block: UserInputBlock;
  sessionId: string | null;
  /** Provider supports phone answers AND this client may mutate the session. */
  canRespond: boolean;
  /** The session record has loaded, so canRespond reflects real capability. */
  sessionLoaded: boolean;
}

export function QuestionCard({ block, sessionId, canRespond, sessionLoaded }: QuestionCardProps) {
  if (block.resolvedBy) {
    return <AnsweredCard block={block} />;
  }
  // Until the session loads we don't yet know whether this client can answer, so
  // show a neutral pending shell rather than flashing the "answer from web" state.
  if (!sessionLoaded) {
    return <WaitingCard block={block} loading />;
  }
  if (!canRespond || !sessionId) {
    return <WaitingCard block={block} />;
  }
  return <PendingCard block={block} sessionId={sessionId} />;
}

/** Small numbered chip that anchors each option to a row number. */
function OptionBadge({ index, selected }: { index: number; selected: boolean }) {
  return (
    <View
      className={`h-6 w-6 items-center justify-center rounded-md border ${
        selected ? 'border-primary bg-primary' : 'border-border'
      }`}
    >
      <Text className={`text-xs font-semibold ${selected ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
        {optionBadge(index)}
      </Text>
    </View>
  );
}

function Eyebrow({ label, color }: { label: string; color?: string }) {
  return (
    <Text
      className="text-xs font-semibold uppercase text-muted-foreground"
      style={[{ letterSpacing: 1 }, color ? { color } : null]}
    >
      {label}
    </Text>
  );
}

function PendingCard({ block, sessionId }: { block: UserInputBlock; sessionId: string }) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selections, setSelections] = useState<SelectionMap>({});
  const [notes, setNotes] = useState<NoteMap>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const questions = block.questions;
  const total = questions.length;
  const question = questions[questionIndex];
  const selectedIds = selections[question?.id ?? ''] ?? [];
  const currentAnswered = question ? questionAnswered(selections, notes, question) : false;
  const readyToSubmit = allAnswered(selections, notes, questions);
  const isLast = questionIndex >= total - 1;

  const choose = (option: UserInputQuestion['options'][number]) => {
    if (submitting || !question) return;
    setSelections((prev) => ({
      ...prev,
      [question.id]: toggleOption(prev[question.id] ?? [], option.id, question.allowMultiple),
    }));
    if (shouldAutoAdvance(question, questionIndex, total)) {
      setQuestionIndex((index) => Math.min(total - 1, index + 1));
    }
  };

  const resolve = async (answers: UserInputAnswer[], resolvedBy: 'user' | 'skip') => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await respondInteraction(sessionId, block.requestId, { answers, resolvedBy });
      // The user_input_resolved event streams back and re-renders this block in
      // its answered state, so there is nothing to reset here.
    } catch (err) {
      const detail = (err as { message?: string })?.message;
      setError(detail || 'Could not submit — try again.');
      setSubmitting(false);
    }
  };

  return (
    <View
      className="my-1.5 rounded-lg bg-card px-4 py-3"
      style={{ borderWidth: 1, borderColor: AMBER }}
    >
      <Eyebrow label="Needs your answer" color={AMBER} />
      {block.title ? <Text className="mt-1 text-base font-semibold text-foreground">{block.title}</Text> : null}
      {total > 1 ? (
        <Text className="mt-1 text-xs text-muted-foreground">
          Question {questionIndex + 1} of {total}
        </Text>
      ) : null}

      {question ? (
        <View className="mt-3 gap-2">
          {question.header ? (
            <Text className="text-xs uppercase text-muted-foreground" style={{ letterSpacing: 0.5 }}>
              {question.header}
            </Text>
          ) : null}
          <Text className="text-base text-foreground">{question.prompt}</Text>
          {question.allowMultiple ? (
            <Text className="text-xs text-muted-foreground">Choose any that apply</Text>
          ) : null}

          <View className="mt-1 gap-2">
            {question.options.map((option, index) => {
              const selected = selectedIds.includes(option.id);
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole={question.allowMultiple ? 'checkbox' : 'radio'}
                  accessibilityState={{ checked: selected, disabled: submitting }}
                  disabled={submitting}
                  onPress={() => choose(option)}
                  className={`min-h-11 flex-row items-center gap-3 rounded-lg border px-3 py-2.5 active:opacity-80 ${
                    selected ? 'border-primary bg-secondary' : 'border-border bg-card'
                  }`}
                >
                  <OptionBadge index={index} selected={selected} />
                  <View className="flex-1">
                    <Text className="text-foreground">{option.label}</Text>
                    {option.description ? (
                      <Text className="mt-0.5 text-xs text-muted-foreground">{option.description}</Text>
                    ) : null}
                  </View>
                  {selected ? <Text className="text-sm text-primary">✓</Text> : null}
                </Pressable>
              );
            })}
          </View>

          <TextInput
            className="mt-1 min-h-11 max-h-28 rounded-lg border border-border px-3 py-2 text-foreground"
            placeholder="Add a note… (optional)"
            placeholderTextColor="#6b7280"
            multiline
            editable={!submitting}
            value={notes[question.id] ?? ''}
            onChangeText={(text) => setNotes((prev) => ({ ...prev, [question.id]: text }))}
          />
        </View>
      ) : null}

      {error ? <Text className="mt-2 text-sm text-destructive">{error}</Text> : null}

      <View className="mt-3 flex-row items-center gap-2">
        {questionIndex > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous question"
            disabled={submitting}
            onPress={() => setQuestionIndex((index) => Math.max(0, index - 1))}
            className="min-h-11 flex-row items-center justify-center rounded-lg border border-border px-3 active:opacity-80"
          >
            <Text className="text-lg text-muted-foreground">‹</Text>
          </Pressable>
        ) : null}

        {isLast ? (
          <Pressable
            accessibilityRole="button"
            disabled={submitting || !readyToSubmit}
            onPress={() => void resolve(buildAnswers(questions, selections, notes), 'user')}
            className={`min-h-11 flex-1 items-center justify-center rounded-lg px-4 active:opacity-90 ${
              submitting || !readyToSubmit ? 'bg-muted' : 'bg-primary'
            }`}
          >
            {submitting ? (
              <ActivityIndicator size="small" />
            ) : (
              <Text className="font-semibold text-primary-foreground">Submit</Text>
            )}
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={submitting || !currentAnswered}
            onPress={() => setQuestionIndex((index) => Math.min(total - 1, index + 1))}
            className={`min-h-11 flex-1 items-center justify-center rounded-lg px-4 active:opacity-90 ${
              submitting || !currentAnswered ? 'bg-muted' : 'bg-primary'
            }`}
          >
            <Text className="font-semibold text-primary-foreground">Next</Text>
          </Pressable>
        )}

        <Pressable
          accessibilityRole="button"
          disabled={submitting}
          onPress={() => void resolve([], 'skip')}
          className="min-h-11 items-center justify-center px-3 active:opacity-70"
        >
          <Text className="font-medium text-muted-foreground">Skip</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Read-only recap once the request is resolved: chosen options checked + note. */
function AnsweredCard({ block }: { block: UserInputBlock }) {
  const skipped = block.resolvedBy === 'skip' || block.resolvedBy === 'timeout';
  const answersByQuestion = new Map<string, UserInputAnswer>();
  for (const answer of block.answers ?? []) answersByQuestion.set(answer.questionId, answer);
  const hasAnswers = (block.answers?.length ?? 0) > 0;

  return (
    <View className="my-1.5 rounded-lg border border-border bg-card px-4 py-3">
      <Eyebrow label={skipped && !hasAnswers ? 'Skipped' : 'Answered'} />
      {block.title ? <Text className="mt-1 text-sm font-semibold text-foreground">{block.title}</Text> : null}

      {hasAnswers ? (
        <View className="mt-2 gap-3">
          {block.questions.map((question) => {
            const answer = answersByQuestion.get(question.id);
            if (!answer) return null;
            return (
              <View key={question.id} className="gap-1.5">
                <Text className="text-sm text-muted-foreground">{question.prompt}</Text>
                {question.options.map((option) => {
                  const selected = answer.selectedOptionIds.includes(option.id);
                  return (
                    <View key={option.id} className="flex-row items-center gap-2">
                      <Text className={`text-sm ${selected ? 'text-primary' : 'text-muted-foreground'}`}>
                        {selected ? '✓' : '·'}
                      </Text>
                      <Text className={selected ? 'text-foreground' : 'text-muted-foreground'}>
                        {option.label}
                      </Text>
                    </View>
                  );
                })}
                {answer.freeText ? (
                  <View className="mt-0.5">
                    <Text className="text-xs uppercase text-muted-foreground" style={{ letterSpacing: 0.5 }}>
                      Note
                    </Text>
                    <Text className="mt-0.5 text-sm text-foreground">{answer.freeText}</Text>
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : (
        <Text className="mt-1 text-sm text-muted-foreground">No answer provided.</Text>
      )}
    </View>
  );
}

/**
 * Pending, but this client isn't answering yet: either the session record is
 * still loading (`loading` — capability unknown, so no CTA) or this client can't
 * answer at all (inspect-only / provider can't take phone input).
 */
function WaitingCard({ block, loading = false }: { block: UserInputBlock; loading?: boolean }) {
  return (
    <View className="my-1.5 rounded-lg bg-card px-4 py-3" style={{ borderWidth: 1, borderColor: AMBER }}>
      <Eyebrow label="Needs your answer" color={AMBER} />
      {block.title ? <Text className="mt-1 text-sm font-semibold text-foreground">{block.title}</Text> : null}
      <Text className="mt-1 text-sm text-muted-foreground">
        {block.questions[0]?.prompt ?? 'The agent is blocked on a question.'}
      </Text>
      {loading ? null : (
        <Text className="mt-2 text-xs text-muted-foreground">Answer it from the web app.</Text>
      )}
    </View>
  );
}
