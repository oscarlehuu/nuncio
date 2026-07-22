import type { CrewGateDto, CrewGateStatus } from '@nuncio/core/crew-api';
import { Ban, Check, Circle, Clock, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type GatePresentation = { variant: 'success' | 'destructive' | 'warning' | 'secondary'; Icon: typeof Check; spin?: boolean };

// Gate status carries the trust signal, so each maps to a semantic color plus a
// redundant icon (color is never the only cue).
const GATE_PRESENTATION: Record<CrewGateStatus, GatePresentation> = {
  passed: { variant: 'success', Icon: Check },
  failed: { variant: 'destructive', Icon: X },
  blocked: { variant: 'destructive', Icon: Ban },
  changes_requested: { variant: 'warning', Icon: TriangleAlert },
  stale: { variant: 'warning', Icon: Clock },
  running: { variant: 'secondary', Icon: LoaderCircle, spin: true },
  pending: { variant: 'secondary', Icon: Circle },
};

export function CrewGates({ gates, currentHead }: { gates: CrewGateDto[]; currentHead: string | null }) {
  return (
    <section aria-labelledby="crew-gates-heading" className="rounded-xl border bg-card p-4">
      <h2 id="crew-gates-heading" className="font-semibold">Gate evidence</h2>
      {gates.length === 0 ? <p className="mt-2 text-ui-sm text-muted-foreground">No gate evidence yet.</p> : (
        <ul className="mt-2 divide-y divide-border">
          {gates.map((gate) => {
            const status = gate.workspaceHead && currentHead && gate.workspaceHead !== currentHead ? 'stale' : gate.status;
            const { variant, Icon, spin } = GATE_PRESENTATION[status];
            return (
              <li key={gate.kind} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium capitalize">{gate.kind}</span>
                  <Badge variant={variant} className="capitalize">
                    <Icon aria-hidden className={cn(spin && 'animate-spin')} />
                    {status.replace('_', ' ')}
                  </Badge>
                </div>
                {gate.workspaceHead ? (
                  <p className="mt-1 font-mono text-ui-sm text-muted-foreground" title={gate.workspaceHead}>HEAD {gate.workspaceHead.slice(0, 7)}</p>
                ) : null}
                {gate.warnings.length > 0 ? (
                  <ul className="mt-2 list-disc pl-5 text-ui-sm text-warning">
                    {gate.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
