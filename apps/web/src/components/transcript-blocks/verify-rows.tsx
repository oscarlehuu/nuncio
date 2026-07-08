import { AlertTriangle, RotateCw } from 'lucide-react';

export interface VerifyRetryRowProps {
  round: number;
  command?: string;
}

/**
 * Compact, informational marker: an auto-retry fired because the post-turn
 * verify failed. It sits immediately before the auto steer_message that carries
 * the failure output, so it stays quiet — a labelled divider, not a card. Never
 * uses the destructive red reserved for real errors.
 */
export function VerifyRetryRow({ round, command }: VerifyRetryRowProps) {
  return (
    <div
      data-testid="verify-retry-row"
      className="flex items-center gap-2 chat-text-2xs text-muted-foreground"
    >
      <span className="h-px flex-1 bg-border" />
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <RotateCw className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
        <span>
          Auto-retry · round {round} · verify failed, steering the agent to fix it
        </span>
        {command ? (
          <code className="rounded bg-muted/60 px-1 py-px font-mono text-muted-foreground/80">
            {command}
          </code>
        ) : null}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export interface VerifyNeedsAttentionRowProps {
  rounds: number;
  reason: 'max_rounds' | 'repeated_failure';
  lastOutputTail?: string;
}

/**
 * The "needs you" signal — the auto-retry loop stopped without a green verify.
 * This is the whole point of the feature, so it reads as a raised amber card
 * (the same warning idiom used for "Waiting for you"), visually distinct from
 * both the muted retry marker and the destructive-red error rows.
 */
export function VerifyNeedsAttentionRow({
  rounds,
  reason,
  lastOutputTail,
}: VerifyNeedsAttentionRowProps) {
  const retryWord = rounds === 1 ? 'retry' : 'retries';
  const cause =
    reason === 'repeated_failure'
      ? 'the same failure kept repeating with no progress'
      : "the fix budget ran out and it's still red";

  return (
    <div
      data-testid="verify-needs-attention-row"
      className="surface-lit shadow-e1 rounded-lg border border-warning/60 bg-card px-3.5 py-3"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          className="mt-px size-4 shrink-0 text-warning"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="chat-text-sm font-medium text-foreground">
            Checks still failing — needs your attention
          </p>
          <p className="chat-text-2xs mt-0.5 text-muted-foreground">
            After {rounds} auto-{retryWord}, {cause}.
          </p>
          {lastOutputTail && lastOutputTail.trim().length > 0 ? (
            <pre className="chat-text-2xs mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 px-2.5 py-2 font-mono text-muted-foreground">
              {lastOutputTail}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}
