import type { ResolvedCrewProfileDto } from '@nuncio/core/crew-api';

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
      <span className="break-words">{label('foreman')} → {label('builder')} → Nuncio Tester → {label('reviewer')}</span>
    </Preview>
  );
}

function Preview({ tone, title, children }: { tone: 'muted' | 'error' | 'warning' | 'success'; title: string; children: React.ReactNode }) {
  const toneClass = tone === 'error' ? 'border-destructive/40 text-destructive' : tone === 'warning' ? 'border-warning/40 text-warning' : tone === 'success' ? 'border-success/30 text-foreground' : 'border-border text-muted-foreground';
  return (
    <div className={`mx-4 mb-2 min-w-0 rounded-lg border px-3 py-2 text-ui-sm ${toneClass}`}>
      <strong className="mr-2">{title}</strong>
      <span className="text-muted-foreground">{children}</span>
    </div>
  );
}
