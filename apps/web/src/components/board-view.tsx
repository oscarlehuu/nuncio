import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Minimize2, MonitorSmartphone } from 'lucide-react';
import type { ProviderRequestDecision, Session, SessionStatus } from '../lib/api';
import { statusLabel } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';
import type { ModelOptionsMap } from '../lib/model-options';
import { DETAIL_EVENT_TAIL, useSessionStream } from '../lib/use-session-stream';
import { useActiveRun } from '../lib/use-active-run';
import { HomeView } from './home-view';
import { SessionDetail } from './session-detail';
import { SessionTile } from './session-tile';
import { StatusDot } from './status-dot';
import type { ApprovalMode } from './approval-mode-picker';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 2×2 live tiles per page; overflow paginates (never a tiling tree). */
const PAGE_SIZE = 4;

/** List lanes group by the cheap status field; pending-input shows on the tile border. */
const STATUS_ORDER: SessionStatus[] = ['RUNNING', 'IDLE', 'PAUSED', 'ERROR', 'CREATED'];

interface BoardViewProps {
  sessions: Session[];
  providers: ModelProvider[];
  approvalMode: ApprovalMode;
  onApprovalModeChange: (mode: ApprovalMode) => void | Promise<void>;
  onRespondProviderRequest: (
    id: string,
    requestId: string,
    decision: ProviderRequestDecision,
  ) => void | Promise<void>;
  onSteerSession: (id: string, message: string) => Promise<void>;
  onPauseSession: (id: string) => Promise<void>;
  onArchiveSession: (id: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onSubmit: (
    prompt: string,
    model?: string,
    provider?: string,
    projectPath?: string,
    baseBranch?: string,
    modelOptions?: ModelOptionsMap,
    useWorktree?: boolean,
  ) => Promise<void>;
  steering?: boolean;
  lifecycleBusy?: boolean;
  creating?: boolean;
  /** True when the unpinned sidebar hover rail overlays the content's left edge. */
  railOverlay?: boolean;
}

export function BoardView(props: BoardViewProps) {
  const { sessions, providers } = props;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const sessionsById = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.id, s);
    return map;
  }, [sessions]);

  const pageCount = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageSlice = sessions.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  const groups = useMemo(() => {
    const byStatus = new Map<SessionStatus, Session[]>();
    for (const s of sessions) {
      const list = byStatus.get(s.status) ?? [];
      list.push(s);
      byStatus.set(s.status, list);
    }
    return STATUS_ORDER.map((status) => ({ status, items: byStatus.get(status) ?? [] })).filter(
      (g) => g.items.length > 0,
    );
  }, [sessions]);

  // Focus a session's tile, flipping to its page when it lives off-screen.
  const focusSession = (id: string) => {
    const index = sessions.findIndex((s) => s.id === id);
    if (index >= 0) setPage(Math.floor(index / PAGE_SIZE));
    setFocusedId(id);
  };

  // Maximize: mount ONLY the full SessionDetail (mirrors the grid's maximize).
  if (maximizedId) {
    const session = sessionsById.get(maximizedId);
    if (session) {
      return (
        <MaximizedSession
          session={session}
          providers={providers}
          approvalMode={props.approvalMode}
          onApprovalModeChange={props.onApprovalModeChange}
          onRespondProviderRequest={(requestId, decision) =>
            props.onRespondProviderRequest(session.id, requestId, decision)
          }
          onSteer={(message) => props.onSteerSession(session.id, message)}
          onPause={() => props.onPauseSession(session.id)}
          onArchive={() => props.onArchiveSession(session.id)}
          onRestore={props.onRestore}
          onDelete={props.onDelete}
          onRename={props.onRename}
          steering={props.steering}
          lifecycleBusy={props.lifecycleBusy}
          onRestoreBoard={() => setMaximizedId(null)}
        />
      );
    }
    // Bound session vanished while maximized — fall back to the board.
    setMaximizedId(null);
  }

  return (
    <section className="flex flex-1 flex-col min-h-0 min-w-0">
      {/* Below md the board is not usable — CSS-only gate, mobile keeps single-session. */}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center md:hidden">
        <MonitorSmartphone className="size-8 text-muted-foreground" />
        <div>
          <h1 className="text-[17px] font-medium">The board needs a desktop viewport</h1>
          <p className="mx-auto mt-1 max-w-[320px] text-[13px] text-muted-foreground">
            Open a single session from the sidebar to keep working on this device.
          </p>
        </div>
      </div>

      <div className="hidden min-h-0 flex-1 flex-col md:flex">
        {/* Composer — reuse HomeView, embedded (no landing layout, no connection pills). */}
        <div className={cn('shrink-0 border-b border-border', props.railOverlay && 'pl-16')}>
          <HomeView
            embedded
            sessionCount={sessions.length}
            providers={providers}
            onSubmit={props.onSubmit}
            approvalMode={props.approvalMode}
            onApprovalModeChange={props.onApprovalModeChange}
            loading={props.creating}
          />
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
          {/* Left list — navigate + focus a tile (double-click maximizes). */}
          <aside className="min-h-0 overflow-y-auto border-r border-border p-3">
            {groups.length === 0 ? (
              <p className="px-1 py-2 text-[12px] italic text-muted-foreground">No sessions yet.</p>
            ) : (
              groups.map((group) => (
                <div key={group.status} className="mb-3">
                  <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {statusLabel(group.status)} · {group.items.length}
                  </div>
                  <div className="flex flex-col gap-1">
                    {group.items.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => focusSession(s.id)}
                        onDoubleClick={() => setMaximizedId(s.id)}
                        aria-current={focusedId === s.id ? 'true' : undefined}
                        className={cn(
                          'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
                          focusedId === s.id
                            ? 'border-ring bg-accent/40'
                            : 'border-transparent hover:bg-muted/60',
                        )}
                      >
                        <StatusDot status={s.status} className="shrink-0" />
                        <span className="truncate text-[12.5px]">{s.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </aside>

          {/* Grid area — pager sits on top so tiles get the height. */}
          <div className="flex min-h-0 min-w-0 flex-col">
            <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Workbench
                </span>
                <h1 className="text-[15px] font-medium leading-tight">Board</h1>
              </div>
              {pageCount > 1 ? (
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="Previous page"
                    disabled={clampedPage === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <span className="text-[12px] tabular-nums text-muted-foreground">
                    {clampedPage + 1} / {pageCount}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="Next page"
                    disabled={clampedPage >= pageCount - 1}
                    onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              ) : null}
            </header>

            <div
              className="grid min-h-0 flex-1 gap-2.5 p-2.5 [grid-auto-rows:minmax(0,1fr)]"
              style={{
                gridTemplateColumns:
                  pageSlice.length <= 1 ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))',
              }}
            >
              {pageSlice.length === 0 ? (
                <div className="flex items-center justify-center text-[13px] text-muted-foreground">
                  No sessions yet — delegate one above.
                </div>
              ) : (
                pageSlice.map((session, i) => {
                  // A lone tile on an odd-count page spans both columns instead of
                  // sitting half-width; a single session fills the pane (1×1).
                  const spanFull =
                    pageSlice.length > 1 &&
                    pageSlice.length % 2 === 1 &&
                    i === pageSlice.length - 1;
                  return (
                    <div
                      key={session.id}
                      className={cn('grid min-h-0 min-w-0', spanFull && 'col-span-2')}
                    >
                      <SessionTile
                        session={session}
                        focused={focusedId === session.id}
                        onFocus={() => setFocusedId(session.id)}
                        onMaximize={() => setMaximizedId(session.id)}
                        onSteer={(msg) => props.onSteerSession(session.id, msg)}
                        steering={props.steering}
                      />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

interface MaximizedSessionProps {
  session: Session;
  providers: ModelProvider[];
  approvalMode: ApprovalMode;
  onApprovalModeChange: (mode: ApprovalMode) => void | Promise<void>;
  onRespondProviderRequest: (
    requestId: string,
    decision: ProviderRequestDecision,
  ) => void | Promise<void>;
  onSteer: (message: string) => Promise<void>;
  onPause: () => Promise<void>;
  onArchive: () => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  steering?: boolean;
  lifecycleBusy?: boolean;
  onRestoreBoard: () => void;
}

function MaximizedSession({
  session,
  providers,
  approvalMode,
  onApprovalModeChange,
  onRespondProviderRequest,
  onSteer,
  onPause,
  onArchive,
  onRestore,
  onDelete,
  onRename,
  steering,
  lifecycleBusy,
  onRestoreBoard,
}: MaximizedSessionProps) {
  // Same stream + active-run wiring SessionRoute/GridView use; resumes via cursor.
  const { events, refetch, loadEarlier, hasEarlier } = useSessionStream(
    session.id,
    '',
    DETAIL_EVENT_TAIL,
  );
  const machineActive = useActiveRun(session, { onTranscriptRefreshed: refetch });

  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      <SessionDetail
        headerActions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5"
            onClick={onRestoreBoard}
            aria-label="Restore board"
          >
            <Minimize2 className="size-3.5" />
            Board
          </Button>
        }
        session={session}
        events={events}
        hasEarlier={hasEarlier}
        onLoadEarlier={loadEarlier}
        providers={providers}
        onSteer={onSteer}
        onPause={onPause}
        onArchive={onArchive}
        onRestore={onRestore}
        onDelete={onDelete}
        onRename={onRename}
        approvalMode={approvalMode}
        onApprovalModeChange={onApprovalModeChange}
        onRespondProviderRequest={onRespondProviderRequest}
        steering={steering}
        lifecycleBusy={lifecycleBusy}
        machineActive={machineActive}
      />
    </div>
  );
}
