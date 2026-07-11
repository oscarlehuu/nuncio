import { Check, Circle, TriangleAlert } from 'lucide-react';
import type { ResolvedCrewProfileDto } from '@nuncio/core/crew-api';
import { cn } from '@/lib/utils';
import { CrewRosterLine } from './crew-roster-line';

export function ResolvedCrewPreview({
  resolution,
  loading,
  error,
  needsProject,
}: {
  resolution: ResolvedCrewProfileDto | null;
  loading: boolean;
  error: string | null;
  needsProject: boolean;
}) {
  if (needsProject) return <Preview tone="muted" title="Choose a project">Crew runs in one project worktree.</Preview>;
  if (loading) return <Preview tone="muted" title="Resolving crew…">Checking live provider and model availability.</Preview>;
  if (error) return <Preview tone="error" title="Unable to resolve crew">{error}</Preview>;
  if (!resolution) return <Preview tone="muted" title="No Crew profile">Create one in Settings to delegate with Crew.</Preview>;
  if (resolution.state === 'needs_setup') {
    return (
      <Preview tone="warning" title="Needs setup">
        <span>{resolution.issues.map((issue) => issue.message).join(' · ') || 'A required role is unavailable.'}</span>{' '}
        <a className="font-medium underline underline-offset-2" href="/settings?section=crew-profiles">Set up profile</a>
      </Preview>
    );
  }
  const { bindings } = resolution.snapshot;
  const label = (role: keyof typeof bindings) => bindings[role].label || bindings[role].model;
  return (
    <Preview tone="success" title="Ready">
      <CrewRosterLine foreman={label('foreman')} builder={label('builder')} reviewer={label('reviewer')} className="mt-0.5" />
    </Preview>
  );
}

const TONES = {
  muted: { cls: 'border-border text-muted-foreground', Icon: Circle },
  error: { cls: 'border-destructive/40 bg-destructive/5 text-destructive', Icon: TriangleAlert },
  warning: { cls: 'border-warning/40 bg-warning/5 text-warning', Icon: TriangleAlert },
  success: { cls: 'border-success/30 bg-success/5 text-foreground', Icon: Check },
} as const;

function Preview({ tone, title, children }: { tone: keyof typeof TONES; title: string; children: React.ReactNode }) {
  const { cls, Icon } = TONES[tone];
  return (
    <div className={cn('mx-4 mb-2 flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 text-ui-sm', cls)}>
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <strong className="mr-2">{title}</strong>
        {children}
      </div>
    </div>
  );
}
