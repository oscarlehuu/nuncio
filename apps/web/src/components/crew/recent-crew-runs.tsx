import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  fetchCrewRuns,
  type CrewRunSummaryDto,
} from '@nuncio/core/crew-api';
import { relativeTime } from '../../lib/api';
import { Button } from '@/components/ui/button';

const RECENT_LIMIT = 5;
const RECENT_POLL_MS = 5_000;

interface RecentCrewRow {
  run: CrewRunSummaryDto;
  objective: string;
}

export function RecentCrewRuns() {
  const [rows, setRows] = useState<RecentCrewRow[] | null>(null);
  const [error, setError] = useState(false);
  const requestId = useRef(0);
  const inFlightToken = useRef<symbol | null>(null);

  const load = useCallback(async () => {
    if (inFlightToken.current) return;
    const token = Symbol('recent-crew-request');
    inFlightToken.current = token;
    const current = ++requestId.current;
    setError(false);
    try {
      const runs = await fetchCrewRuns({ limit: RECENT_LIMIT });
      if (current !== requestId.current) return;
      setRows(runs.map((run) => ({ run, objective: run.objective })));
    } catch {
      if (current !== requestId.current) return;
      setError(true);
    } finally {
      if (inFlightToken.current === token) inFlightToken.current = null;
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
      inFlightToken.current = null;
    };
  }, [load]);

  const hasActiveRun = rows?.some(({ run }) => run.status !== 'TERMINAL') ?? false;
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setInterval(() => void load(), RECENT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, load]);

  return (
    <section aria-labelledby="recent-crew-heading" className="rounded-xl border bg-card p-4">
      <h2 id="recent-crew-heading" className="text-ui-lg font-semibold">Recent Crew</h2>
      {rows === null && !error ? <p className="mt-2 text-ui-sm text-muted-foreground">Loading recent Crew…</p> : null}
      {error ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-ui-sm text-muted-foreground">Recent Crew unavailable</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            aria-label="Retry recent Crew"
            onClick={() => void load()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {rows?.length === 0 ? <p className="mt-2 text-ui-sm text-muted-foreground">No Crew tasks yet.</p> : null}
      {rows && rows.length > 0 ? (
        <ul className="mt-2 divide-y divide-border">
          {rows.map(({ run, objective }) => (
            <li key={run.taskId}>
              <Link
                to={crewRunPath(run)}
                className="flex min-h-11 min-w-0 items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium" title={objective}>{objective}</span>
                  <span className="block truncate text-ui-sm text-muted-foreground">
                    {title(run.phase)} · {title(run.outcome ?? run.status)} · {relativeTime(run.updatedAt)}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function crewRunPath(run: CrewRunSummaryDto): string {
  return `/crew/${encodeURIComponent(run.taskId)}?run=${encodeURIComponent(run.id)}`;
}

function title(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}
