import {
  deriveCrewOutcomeEvidence,
  type CrewRunDetailDto,
} from '@nuncio/core/crew-api';

export function CrewOutcomeEvidence({ run }: { run: CrewRunDetailDto }) {
  const evidence = deriveCrewOutcomeEvidence(run);
  if (!evidence) return null;
  if (evidence.state === 'incomplete') {
    return (
      <section role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3">
        <h2 className="font-semibold text-foreground">Outcome evidence unavailable</h2>
        <p className="mt-1 text-ui-sm text-muted-foreground">{evidence.warning}</p>
        <ReviewWarnings warnings={evidence.reviewWarnings} />
      </section>
    );
  }
  return (
    <section aria-labelledby="crew-outcome-heading" className="rounded-xl border bg-card px-4 py-4 shadow-e1 surface-lit">
      <h2 id="crew-outcome-heading" className="font-semibold text-foreground">Outcome</h2>
      <p className="mt-2 text-body text-foreground">{evidence.summary}</p>
      <h3 className="mt-4 text-ui-sm font-semibold text-muted-foreground">Foreman verification summary</h3>
      <p className="mt-1 text-ui-sm text-foreground">{evidence.verification}</p>
      <h3 className="mt-4 text-ui-sm font-semibold text-muted-foreground">Remaining risks</h3>
      {evidence.remainingRisks.length ? (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-ui-sm text-foreground">
          {evidence.remainingRisks.map((risk) => <li key={risk}>{risk}</li>)}
        </ul>
      ) : <p className="mt-1 text-ui-sm text-muted-foreground">No remaining risks reported.</p>}
      <ReviewWarnings warnings={evidence.reviewWarnings} />
    </section>
  );
}

function ReviewWarnings({ warnings }: {
  warnings: Array<{ title: string; body: string }>;
}) {
  if (!warnings.length) return null;
  return (
    <div className="mt-4">
      <h3 className="text-ui-sm font-semibold text-muted-foreground">Nonblocking review warnings</h3>
      <ul className="mt-1 space-y-2">
        {warnings.map((warning) => (
          <li key={`${warning.title}:${warning.body}`} className="text-ui-sm text-foreground">
            <p className="font-medium">{warning.title}</p>
            <p className="text-muted-foreground">{warning.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
