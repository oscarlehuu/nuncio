import { useEffect, useState } from 'react';
import { relativeTime } from '../lib/api';
import { fetchHeartbeatHealth, type HeartbeatHealthDto } from '../lib/heartbeat-health-api';

/** Human labels for the system jobs (kept here so the API stays value-only). */
const JOB_LABELS: Record<HeartbeatHealthDto['job'], string> = {
  infra: 'Infra self-check',
  reconcile: 'Fleet reconcile',
  'digest-morning': 'Morning digest',
  'digest-evening': 'Evening digest',
};

function outcomeClass(outcome: HeartbeatHealthDto['outcome']): string {
  return outcome === 'ok' ? 'text-muted-foreground' : 'text-destructive';
}

/**
 * Read-only heartbeat health — the last-run timestamp + outcome of each system
 * job, so a swallowed layer failure is visible. Facts only; no controls.
 */
export function HeartbeatHealthSection() {
  const [items, setItems] = useState<HeartbeatHealthDto[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchHeartbeatHealth()
      .then(setItems)
      .catch(() => {
        // Unreachable server / not yet run — render the empty state, never crash.
      })
      .finally(() => setLoaded(true));
  }, []);

  return (
    <section>
      <h2 className="mb-2 text-ui-lg font-medium text-muted-foreground">Heartbeat health</h2>
      {items.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-ui text-muted-foreground">
          {loaded ? 'No heartbeat runs recorded yet.' : 'Loading…'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border/60">
          {items.map((item) => (
            <div key={item.job} className="flex flex-col gap-0.5 px-4 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ui text-foreground">{JOB_LABELS[item.job] ?? item.job}</span>
                <span className={`font-mono text-ui-sm uppercase tracking-wide ${outcomeClass(item.outcome)}`}>
                  {item.outcome}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-ui-sm text-muted-foreground">
                  {relativeTime(item.lastRunAt)}
                </span>
              </div>
              {item.detail && item.outcome !== 'ok' && (
                <p className="mt-0.5 font-mono text-ui-sm text-destructive/90 break-words">{item.detail}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
