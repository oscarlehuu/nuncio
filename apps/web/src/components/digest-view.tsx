import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpRight,
  Clock3,
  GitPullRequestArrow,
  Inbox as InboxIcon,
  Moon,
  Repeat,
  Sparkles,
  Sunrise,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { fetchDigest, relativeTime, type Digest, type DigestHighlight, type DigestProjectLine, type DigestRunDto } from '../lib/api';
import { projectDisplayName } from '../lib/projects';
import { timelineTargetFor } from '../lib/timeline-links';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DigestViewProps {
  onBack: () => void;
}

const VARIANT_META = {
  morning: { title: 'Morning digest', icon: Sunrise, blurb: 'What happened while you were away.' },
  evening: { title: 'Evening pre-flight', icon: Moon, blurb: 'Where the fleet stands tonight.' },
} as const;

/** A calm briefing, not a dashboard — one screen you read with coffee. */
export function DigestView({ onBack }: DigestViewProps) {
  const navigate = useNavigate();
  const [dto, setDto] = useState<DigestRunDto | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setDto(await fetchDigest('latest'));
    } catch {
      toast.error('Failed to load the digest');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background/80 backdrop-blur z-10">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Digest</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-8">
        <div className="mx-auto w-full max-w-[560px]">
          {loading ? (
            <div className="space-y-4" aria-hidden>
              <div className="h-20 rounded-2xl bg-muted/50 animate-pulse" />
              <div className="h-40 rounded-2xl bg-muted/40 animate-pulse" />
            </div>
          ) : dto === null ? (
            <NoDigestYet />
          ) : (
            <DigestBody
              dto={dto}
              onOpenInbox={() => navigate('/inbox')}
              onOpenAutopilot={() => navigate('/autopilot')}
              onOpenTimeline={() => navigate('/timeline')}
              onOpenTarget={(target) => {
                if ('href' in target) window.open(target.href, '_blank', 'noopener,noreferrer');
                else navigate(target.to);
              }}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function DigestBody({
  dto,
  onOpenInbox,
  onOpenAutopilot,
  onOpenTimeline,
  onOpenTarget,
}: {
  dto: DigestRunDto;
  onOpenInbox: () => void;
  onOpenAutopilot: () => void;
  onOpenTimeline: () => void;
  onOpenTarget: (target: NonNullable<ReturnType<typeof timelineTargetFor>>) => void;
}) {
  const { digest } = dto;
  const meta = VARIANT_META[digest.variant];
  const Icon = meta.icon;
  const quiet = isQuiet(digest);
  const highlights = digest.highlights ?? [];
  const projectLines = digest.projectLines ?? [];

  return (
    <div className="space-y-6">
      {/* Hero — the variant, the window, one human line. */}
      <div>
        <div className="flex items-center gap-2 text-ui-sm font-medium uppercase tracking-wide text-muted-foreground">
          <Icon className="size-4" />
          {formatWindow(dto.windowFrom, dto.windowTo)}
        </div>
        <h2 className="mt-2 font-heading text-2xl font-semibold tracking-tight text-foreground">{meta.title}</h2>
        <p className="mt-1 text-ui-lg text-muted-foreground">{quiet ? quietLine(digest.variant) : meta.blurb}</p>
      </div>

      {/* Sections — compact, scannable, each links where you'd act. */}
      <Section
        icon={InboxIcon}
        title="Attention"
        onOpen={onOpenInbox}
        openLabel="Open inbox"
        summary={
          digest.attention.openTopCount > 0
            ? `${digest.attention.openTopCount} still open`
            : 'All clear'
        }
      >
        <Stat label="Raised" value={digest.attention.raised} />
        <Stat label="Resolved" value={digest.attention.resolved} tone={digest.attention.resolved > 0 ? 'success' : undefined} />
        <Stat
          label="Open now"
          value={digest.attention.openTopCount}
          tone={digest.attention.openTopCount > 0 ? 'warning' : undefined}
        />
      </Section>

      <Section
        icon={Repeat}
        title="Autopilot"
        onOpen={onOpenAutopilot}
        openLabel="Open autopilot"
        summary={`${digest.budget.runsToday}/${digest.budget.cap} runs today`}
      >
        <Stat label="Succeeded" value={digest.loops.runsOk} tone={digest.loops.runsOk > 0 ? 'success' : undefined} />
        <Stat label="Failed" value={digest.loops.runsFailed} tone={digest.loops.runsFailed > 0 ? 'warning' : undefined} />
        <Stat label="PRs opened" value={digest.loops.prsOpened} icon={GitPullRequestArrow} />
      </Section>

      <Section icon={Sparkles} title="Sessions">
        <Stat label="Completed" value={digest.sessions.completed} />
        <Stat
          label="Need you"
          value={digest.sessions.needsYou}
          tone={digest.sessions.needsYou > 0 ? 'warning' : undefined}
        />
      </Section>

      {highlights.length > 0 && (
        <HighlightsSection highlights={highlights} onOpenTarget={onOpenTarget} onOpenTimeline={onOpenTimeline} />
      )}

      {projectLines.length > 0 && <ProjectLinesSection lines={projectLines} />}

      <button
        type="button"
        onClick={onOpenTimeline}
        className="inline-flex items-center gap-1 rounded text-ui-sm font-medium text-primary transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        See full timeline
        <ArrowUpRight className="size-3.5" />
      </button>
    </div>
  );
}

function HighlightsSection({
  highlights,
  onOpenTarget,
  onOpenTimeline,
}: {
  highlights: DigestHighlight[];
  onOpenTarget: (target: NonNullable<ReturnType<typeof timelineTargetFor>>) => void;
  onOpenTimeline: () => void;
}) {
  return (
    <div className="surface-lit rounded-2xl border border-border bg-card p-4 shadow-e1">
      <div className="mb-3 flex items-center gap-2">
        <Clock3 className="size-4 text-muted-foreground" />
        <h3 className="text-ui-lg font-medium text-foreground">Highlights</h3>
        <button
          type="button"
          onClick={onOpenTimeline}
          className="ml-auto rounded text-ui-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          See full timeline
        </button>
      </div>
      <ul className="space-y-2">
        {highlights.map((entry) => {
          const target = timelineTargetFor(entry);
          const project = projectDisplayName(entry.projectPath);
          return (
            <li key={entry.id} className="flex items-start gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
              <span className="mt-1 size-2 rounded-full bg-info" aria-label={entry.kind} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui font-medium text-foreground">{entry.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-sm text-muted-foreground">
                  {project && <span>{project}</span>}
                  {project && <span aria-hidden>-</span>}
                  <span>{relativeTime(entry.ts)}</span>
                </p>
              </div>
              {target && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2.5"
                  onClick={() => onOpenTarget(target)}
                  aria-label={`Open ${entry.title}`}
                >
                  <ArrowUpRight className="size-3.5" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ProjectLinesSection({ lines }: { lines: DigestProjectLine[] }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
      <h3 className="text-ui-lg font-medium text-foreground">Project lines</h3>
      <ul className="mt-3 divide-y divide-border/70">
        {lines.map((line, idx) => (
          <li key={`${line.projectPath ?? 'none'}:${idx}`} className="py-2 first:pt-0 last:pb-0">
            <p className="text-ui text-foreground">{line.title}</p>
            {line.projectPath && <p className="mt-0.5 text-ui-sm text-muted-foreground">{projectDisplayName(line.projectPath)}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SectionProps {
  icon: LucideIcon;
  title: string;
  summary?: string;
  onOpen?: () => void;
  openLabel?: string;
  children: React.ReactNode;
}

function Section({ icon: Icon, title, summary, onOpen, openLabel, children }: SectionProps) {
  return (
    <div className="surface-lit rounded-2xl border border-border bg-card p-4 shadow-e1">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <h3 className="text-ui-lg font-medium text-foreground">{title}</h3>
        {summary && <span className="ml-auto text-ui-sm text-muted-foreground">{summary}</span>}
      </div>
      <dl className="grid grid-cols-3 gap-3">{children}</dl>
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={openLabel}
          className="mt-3 inline-flex items-center gap-1 rounded text-ui-sm font-medium text-primary transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {openLabel}
          <ArrowUpRight className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  tone?: 'success' | 'warning';
  icon?: LucideIcon;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-ui-sm text-muted-foreground">
        {Icon && <Icon className="size-3" />}
        {label}
      </dt>
      <dd
        className={cn(
          'mt-0.5 text-xl font-semibold tabular-nums leading-none',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
          !tone && 'text-foreground',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function NoDigestYet() {
  return (
    <div className="mx-auto flex max-w-[380px] flex-col items-center gap-4 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-muted/60 text-muted-foreground shadow-e0">
        <Sunrise className="size-6" />
      </span>
      <div className="space-y-1.5">
        <h2 className="text-ui-lg font-semibold text-foreground">No digest yet</h2>
        <p className="text-ui text-muted-foreground leading-relaxed">
          Your first briefing lands with the next morning or evening heartbeat.
        </p>
      </div>
    </div>
  );
}

/** A digest with no deltas and nothing open reads as good news, not emptiness. */
function isQuiet(d: Digest): boolean {
  return (
    d.loops.runsOk === 0 &&
    d.loops.runsFailed === 0 &&
    d.loops.prsOpened === 0 &&
    d.attention.raised === 0 &&
    d.attention.openTopCount === 0 &&
    d.sessions.completed === 0 &&
    d.sessions.needsYou === 0
  );
}

function quietLine(variant: Digest['variant']): string {
  return variant === 'evening'
    ? 'A quiet evening — nothing ran and nothing needs you.'
    : 'A quiet night — nothing ran and nothing needs you.';
}

function formatWindow(from: number, to: number): string {
  if (!from || !to) return 'Latest';
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const f = new Date(from).toLocaleString(undefined, opts);
  const t = new Date(to).toLocaleString(undefined, opts);
  return `${f} → ${t}`;
}
