import type { CrewGateDto } from '@nuncio/core/crew-api';
import { Badge } from '@/components/ui/badge';

export function CrewGates({ gates, currentHead }: { gates: CrewGateDto[]; currentHead: string | null }) {
  return (
    <section aria-labelledby="crew-gates-heading" className="rounded-xl border bg-card p-4">
      <h2 id="crew-gates-heading" className="font-semibold">Gate evidence</h2>
      {gates.length === 0 ? <p className="mt-2 text-ui-sm text-muted-foreground">No gate evidence yet.</p> : (
        <ul className="mt-2 space-y-3">
          {gates.map((gate) => {
            const status = gate.workspaceHead && currentHead && gate.workspaceHead !== currentHead ? 'stale' : gate.status;
            return (
              <li key={gate.kind} className="rounded-lg border border-border/70 p-3">
                <div className="flex items-center justify-between gap-2"><span className="capitalize font-medium">{gate.kind}</span><Badge variant="outline" className="capitalize">{status.replace('_', ' ')}</Badge></div>
                {gate.workspaceHead ? <p className="mt-1 truncate font-mono text-ui-sm text-muted-foreground" title={gate.workspaceHead}>HEAD {gate.workspaceHead}</p> : null}
                {gate.warnings.length > 0 ? <ul className="mt-2 list-disc pl-5 text-ui-sm text-warning">{gate.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
