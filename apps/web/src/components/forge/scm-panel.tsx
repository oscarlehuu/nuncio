import { lazy, Suspense, useState } from 'react';
import type { Session } from '../../lib/api';
import type { ForgeWorkflowRun } from '../../lib/forge-api';
import type { ScmSegment } from '../../lib/inspector-preference';
import { PrPanel } from '../pr-panel';
import { IssueDetail } from './issue-detail';
import { IssueList } from './issue-list';
import { PrDetail } from './pr-detail';
import { PrList } from './pr-list';
import { RunDetail } from './run-detail';
import { RunList } from './run-list';
import { cn } from '@/lib/utils';

interface ScmPanelProps {
  session: Session;
  workingDir?: string;
  segment: ScmSegment;
  onSegmentChange: (segment: ScmSegment) => void;
}

const SEGMENTS: Array<{ id: ScmSegment; label: string }> = [
  { id: 'changes', label: 'Changes' },
  { id: 'pulls', label: 'PR' },
  { id: 'issues', label: 'Issues' },
  { id: 'actions', label: 'Actions' },
];

const SessionChangesPanel = lazy(() =>
  import('../session-changes-panel').then((module) => ({ default: module.SessionChangesPanel })),
);

/**
 * The SCM inspector tab: local changes, this session's PR, and repo-level
 * PR/issue browsing — all scoped to the session's project.
 */
export function ScmPanel({ session, workingDir, segment, onSegmentChange }: ScmPanelProps) {
  const [openPull, setOpenPull] = useState<number | null>(null);
  const [openIssue, setOpenIssue] = useState<number | null>(null);
  const [openRun, setOpenRun] = useState<ForgeWorkflowRun | null>(null);

  const repoPath = workingDir ?? session.projectPath ?? undefined;
  const forgeReady = !!repoPath;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
        {SEGMENTS.map((item) => {
          const disabled = item.id !== 'changes' && !forgeReady;
          return (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              onClick={() => onSegmentChange(item.id)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium',
                segment === item.id
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {segment === 'changes' && (
          <>
            <div className="border-b border-border/60 bg-card/40">
              <Suspense fallback={<div className="px-3 py-3 text-sm text-muted-foreground">Loading changes…</div>}>
                <SessionChangesPanel
                  sessionId={session.id}
                  sessionStatus={session.status}
                  repoPath={repoPath}
                  branch={session.branch}
                />
              </Suspense>
            </div>
            <PrPanel session={session} repoPath={repoPath} />
          </>
        )}

        {segment === 'pulls' &&
          forgeReady &&
          (openPull != null ? (
            <PrDetail path={repoPath} number={openPull} onBack={() => setOpenPull(null)} />
          ) : (
            <PrList path={repoPath} onOpen={setOpenPull} />
          ))}

        {segment === 'issues' &&
          forgeReady &&
          (openIssue != null ? (
            <IssueDetail
              path={repoPath}
              number={openIssue}
              projectPath={session.projectPath}
              onBack={() => setOpenIssue(null)}
            />
          ) : (
            <IssueList path={repoPath} onOpen={setOpenIssue} />
          ))}

        {segment === 'actions' &&
          forgeReady &&
          (openRun != null ? (
            <RunDetail path={repoPath} run={openRun} onBack={() => setOpenRun(null)} />
          ) : (
            <RunList path={repoPath} branch={session.branch} onOpen={setOpenRun} />
          ))}
      </div>
    </div>
  );
}
