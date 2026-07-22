import {
  GitPullRequestArrow,
  ListChecks,
  MessageSquareWarning,
  Radar,
  ShieldQuestion,
  Sparkles,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { AttentionItemDto } from './api';

/**
 * Presentation metadata per attention kind. Tone maps to the established status
 * idiom: `warning` (amber) is the needs-you class (permission / verify-dead /
 * tripped-breaker — matching verify_needs_attention + broken-loop today);
 * `info` for the calmer review class (pr-review). Red/destructive stays reserved
 * for hard failures, so it is NOT used here. An unknown kind falls back to a
 * neutral chip + humanized label so a future server kind never breaks the row.
 */
export type AttentionTone = 'warning' | 'info' | 'neutral';

interface AttentionKindMeta {
  label: string;
  icon: LucideIcon;
  tone: AttentionTone;
}

const KIND_META: Record<string, AttentionKindMeta> = {
  permission: { label: 'Permission', icon: ShieldQuestion, tone: 'warning' },
  'verify-dead': { label: 'Verify stuck', icon: Wrench, tone: 'warning' },
  'tripped-breaker': { label: 'Loop paused', icon: TriangleAlert, tone: 'warning' },
  'pr-review': { label: 'PR review', icon: GitPullRequestArrow, tone: 'info' },
  // Webhook feedback that could not be auto-steered (untrusted author, failed
  // delivery, skipped cleanup) — a needs-you item, so it shares the amber class.
  'pr-feedback': { label: 'PR feedback', icon: MessageSquareWarning, tone: 'warning' },
  anomaly: { label: 'Anomaly', icon: Radar, tone: 'neutral' },
  'dispatcher-proposal': { label: 'Dispatcher proposal', icon: ListChecks, tone: 'info' },
  // A follow-up the agent flagged mid-turn — a proposal, so it shares the calmer
  // review class rather than the amber needs-you one.
  'spawn-task': { label: 'Follow-up', icon: Sparkles, tone: 'info' },
};

export function attentionKindMeta(kind: string): AttentionKindMeta {
  return (
    KIND_META[kind] ?? {
      label: kind.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
      icon: Radar,
      tone: 'neutral',
    }
  );
}

/** Tailwind classes for the tone — the row's left accent + kind chip share this. */
export const TONE_ACCENT: Record<AttentionTone, string> = {
  warning: 'bg-warning',
  info: 'bg-info',
  neutral: 'bg-muted-foreground/50',
};

export const TONE_CHIP: Record<AttentionTone, string> = {
  warning: 'border-warning/40 bg-warning/10 text-warning',
  info: 'border-info/30 bg-info/10 text-info',
  neutral: 'border-border/70 bg-muted/40 text-muted-foreground',
};

/** Where the primary "Open" action points for an item — an in-app route or an external url. */
export type OpenTarget = { to: string } | { href: string };

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function prReviewTarget(item: AttentionItemDto): OpenTarget | null {
  const p = item.payload ?? {};
  const projectPath = payloadString(p, 'projectPath') ?? item.projectPath;
  const number = payloadNumber(p, 'number');
  if (projectPath && number !== null) {
    return { to: `/forge/pr?path=${encodeURIComponent(projectPath)}&number=${number}` };
  }
  const url = payloadString(p, 'url');
  return url ? { href: url } : null;
}

/**
 * Resolve the deep-link per kind from the item's payload (all fields optional —
 * tolerate an unrecognized shape by falling back to the subject or an external
 * url). permission/verify-dead → the session; tripped-breaker → the loop; pr-review
 * → the in-app PR view when project+number exist; unknown → a session if the
 * payload carries one.
 */
export function openTargetFor(item: AttentionItemDto): OpenTarget | null {
  const p = item.payload ?? {};
  const sessionId = payloadString(p, 'sessionId');
  const loopId = payloadString(p, 'loopId');
  const url = payloadString(p, 'url');

  switch (item.kind) {
    case 'permission':
    case 'verify-dead':
      return sessionId ? { to: `/session/${sessionId}` } : { to: `/session/${item.subjectId}` };
    case 'tripped-breaker':
      return { to: `/autopilot/${loopId ?? item.subjectId}` };
    case 'pr-review':
    case 'pr-feedback':
      return prReviewTarget(item);
    default:
      return sessionId ? { to: `/session/${sessionId}` } : url ? { href: url } : null;
  }
}
