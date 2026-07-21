import { Camera, GitCommitHorizontal, TriangleAlert } from 'lucide-react';
import type { EvidenceCapturedPayload } from '@nuncio/core/evidence.types';
import { transcriptImageSrc } from '../../lib/api';
import { ChatImage } from '../chat-image';
import { cn } from '@/lib/utils';

interface EvidenceBlockProps {
  evidence: EvidenceCapturedPayload;
  /** After-shot head has moved past the paired before — evidence may be dated. */
  stale?: boolean;
  /** Owning session — resolves the media-store screenshot URLs. */
  sessionId: string;
  /** Origin-absolute API base when the transcript belongs to another hub machine. */
  apiBase?: string;
}

/** Git-style short sha for the caption; the full head stays in the title. */
function shortHead(head: string): string {
  return head.length > 8 ? head.slice(0, 7) : head;
}

/** A single labelled screenshot that opens to full size in the shared lightbox. */
function Shot({ label, src, route }: { label: string; src: string; route: string }) {
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <figcaption className="flex items-center gap-1.5 text-ui-xs font-semibold uppercase tracking-wide leading-none text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/40" aria-hidden />
        {label}
      </figcaption>
      <ChatImage
        src={src}
        alt={`${label} screenshot of ${route}`}
        className="w-full border-border/50 shadow-none transition hover:shadow-e1 active:scale-[0.98]"
      />
    </figure>
  );
}

/** Holds the after slot with a shot-shaped placeholder until the pair completes. */
function PendingShot({ viewport }: { viewport: { w: number; h: number } }) {
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <figcaption className="flex items-center gap-1.5 text-ui-xs font-semibold uppercase tracking-wide leading-none text-muted-foreground/70">
        <span className="size-1.5 rounded-full bg-muted-foreground/25" aria-hidden />
        After
      </figcaption>
      <div
        data-testid="evidence-pending-after"
        className="flex w-full max-h-64 items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/10 text-ui-sm text-muted-foreground/70"
        style={{ aspectRatio: `${viewport.w} / ${viewport.h}` }}
      >
        <span className="animate-pulse">Awaiting after shot</span>
      </div>
    </figure>
  );
}

export function EvidenceBlock({ evidence, stale, sessionId, apiBase = '' }: EvidenceBlockProps) {
  const { beforeRef, afterRef, route, viewport, workspaceHead } = evidence;
  const paired = !!beforeRef && !!afterRef;
  const heading = paired ? 'Before & after' : beforeRef ? 'Before' : 'After';
  // A lone before is a capture still in flight — reserve the after slot for it.
  const twoUp = paired || (!!beforeRef && !afterRef);

  return (
    <div
      data-testid="evidence-block"
      className={cn(
        'max-w-[88%] overflow-hidden rounded-lg border bg-card text-foreground shadow-e1 surface-lit',
        stale ? 'border-warning/40' : 'border-border/60',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3.5 py-2.5">
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-ui-xs font-semibold uppercase tracking-wide leading-none text-muted-foreground">
          <Camera className="size-3" aria-hidden />
          Evidence
        </span>
        <span className="text-ui-sm font-medium text-foreground/70">{heading}</span>
        {stale && (
          <span
            data-testid="evidence-stale"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-ui-xs font-semibold uppercase tracking-wide leading-none text-warning"
          >
            <TriangleAlert className="size-3" aria-hidden />
            Stale
          </span>
        )}
      </div>

      <div className="border-t border-border/40 p-3">
        <div className={cn('grid gap-3', twoUp && 'sm:grid-cols-2')}>
          {beforeRef && (
            <Shot label="Before" src={transcriptImageSrc(beforeRef, sessionId, apiBase)} route={route} />
          )}
          {afterRef ? (
            <Shot label="After" src={transcriptImageSrc(afterRef, sessionId, apiBase)} route={route} />
          ) : beforeRef ? (
            <PendingShot viewport={viewport} />
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border/40 px-3.5 py-2 text-ui-sm text-muted-foreground">
        <span className="min-w-0 truncate font-mono" title={route}>
          {route}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1" title={workspaceHead}>
          <GitCommitHorizontal className="size-3.5" aria-hidden />
          <span className="font-mono">{shortHead(workspaceHead)}</span>
        </span>
        {stale && (
          <span className="inline-flex min-w-0 items-center gap-1 text-warning">
            <span className="text-muted-foreground/40" aria-hidden>
              ·
            </span>
            The workspace moved on after the before shot — may not reflect current code.
          </span>
        )}
      </div>
    </div>
  );
}
