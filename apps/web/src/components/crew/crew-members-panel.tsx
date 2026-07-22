import type { CrewMemberDto } from '@nuncio/core/crew-api';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

const statusDot = (status: string) =>
  /active|running|working|busy/i.test(status) ? 'bg-success'
    : /fail|error|blocked/i.test(status) ? 'bg-destructive'
      : 'bg-muted-foreground/40';

export function CrewMembersPanel({ members, onOpenSession }: { members: CrewMemberDto[]; onOpenSession?: (sessionId: string) => void }) {
  return (
    <section aria-labelledby="crew-members-heading" className="rounded-xl border bg-card p-4">
      <h2 id="crew-members-heading" className="font-semibold">Members</h2>
      {members.length === 0 ? <p className="mt-2 text-ui-sm text-muted-foreground">Members appear when their phase starts.</p> : (
        <ul className="mt-2 divide-y divide-border">
          {members.map((member) => (
            <li key={member.id} className="flex min-w-0 items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium" title={member.label}>{member.label}</p>
                <p className="truncate text-ui-sm text-muted-foreground"><span className="capitalize">{member.role}</span> · {member.provider} · {member.model}</p>
              </div>
              <span data-status={member.status} className="inline-flex shrink-0 items-center gap-1.5 text-ui-sm text-muted-foreground">
                <span aria-hidden className={cn('size-1.5 rounded-full', statusDot(member.status))} />
                <span className="capitalize">{member.status}</span>
              </span>
              {member.sessionId ? (
                <a href={`/session/${encodeURIComponent(member.sessionId)}`} onClick={onOpenSession ? (event) => { event.preventDefault(); onOpenSession(member.sessionId!); } : undefined} aria-label={`Open ${member.label} member session`} className="flex min-h-11 shrink-0 items-center gap-1 rounded-md px-3 text-ui font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Open<ExternalLink className="size-3.5" /></a>
              ) : <span className="text-ui-sm text-muted-foreground">Not started</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
