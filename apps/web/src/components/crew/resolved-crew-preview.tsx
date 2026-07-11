import { Check, Circle, TriangleAlert } from 'lucide-react';
import type { ResolvedCrewProfileDto } from '@nuncio/core/crew-api';
import { cn } from '@/lib/utils';
import { withBase } from '@/lib/api-base';
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
  if (needsProject) return <Preview tone="muted" title="Choose a project">to enable Crew.</Preview>;
  if (loading) return null;
  if (error) return <Preview tone="error" title="Unable to resolve crew">{error}</Preview>;
  if (!resolution) return null;
  if (resolution.state === 'needs_setup') {
    return (
      <Preview tone="warning" title="Needs setup">
        <span>{resolution.issues.map((issue) => issue.message).join(' · ') || 'A required role is unavailable.'}</span>{' '}
        <a className="font-medium underline underline-offset-2" href={withBase('/settings?section=crew-profiles')}>Set up profile</a>
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
  muted: { cls: 'text-muted-foreground', Icon: Circle },
  error: { cls: 'text-destructive', Icon: TriangleAlert },
  warning: { cls: 'text-warning', Icon: TriangleAlert },
  success: { cls: 'text-muted-foreground', Icon: Check },
} as const;

function Preview({ tone, title, children }: { tone: keyof typeof TONES; title: string; children: React.ReactNode }) {
  const { cls, Icon } = TONES[tone];
  return (
    <div
      data-slot="crew-preview"
      className={cn('mx-5 mb-2 flex min-w-0 items-start gap-1.5 text-ui-xs', cls)}
    >
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <strong className="mr-1.5 text-foreground">{title}</strong>
        {children}
      </div>
    </div>
  );
}
