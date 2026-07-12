import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// One presentation for the fixed crew roster, reused by the composer readiness
// preview and the settings profile row so the line-up reads the same everywhere.
// The tester slot is always the deterministic Nuncio Tester, not a bound model.
export function CrewRosterLine({ foreman, builder, reviewer, className }: {
  foreman: string;
  builder: string;
  reviewer: string;
  className?: string;
}) {
  const roster = [
    { role: 'Foreman', name: foreman },
    { role: 'Builder', name: builder },
    { role: 'Tester', name: 'Nuncio Tester' },
    { role: 'Reviewer', name: reviewer },
  ];
  return (
    <div aria-label="Crew roster" className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-sm', className)}>
      {roster.map((member, index) => (
        <span key={member.role} className="inline-flex max-w-full min-w-0 items-center gap-1.5">
          {index > 0 ? <ArrowRight aria-hidden className="size-3 shrink-0 text-muted-foreground/70" /> : null}
          <span className="min-w-0 break-words font-medium text-foreground" title={`${member.role}: ${member.name}`}>{member.name}</span>
        </span>
      ))}
    </div>
  );
}
