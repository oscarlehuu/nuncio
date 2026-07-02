import { useCallback, useMemo, useState } from 'react';
import { Minimize2, MonitorSmartphone } from 'lucide-react';
import type { ProviderRequestDecision, Session } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';
import type { ModelOptionsMap } from '../lib/model-options';
import { useSessionStream } from '../lib/use-session-stream';
import { useActiveRun } from '../lib/use-active-run';
import {
  fitSlots,
  GRID_PRESETS,
  loadGridPreference,
  PRESET_COLUMNS,
  PRESET_SLOT_COUNT,
  saveGridPreference,
  type GridPreset,
  type GridSlot,
} from '../lib/grid-preference';
import { SessionDetail } from './session-detail';
import { SessionTile } from './session-tile';
import { GridSlotComposer } from './grid-slot-composer';
import type { ApprovalMode } from './approval-mode-picker';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface GridViewProps {
  sessions: Session[];
  providers: ModelProvider[];
  approvalMode: ApprovalMode;
  onApprovalModeChange: (mode: ApprovalMode) => void | Promise<void>;
  onRespondProviderRequest: (
    id: string,
    requestId: string,
    decision: ProviderRequestDecision,
  ) => void | Promise<void>;
  /** Steer a specific session (grid focus is not the global active route id). */
  onSteerSession: (id: string, message: string) => Promise<void>;
  onPauseSession: (id: string) => Promise<void>;
  onArchiveSession: (id: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onCreate: (
    prompt: string,
    model?: string,
    provider?: string,
    projectPath?: string,
    baseBranch?: string,
    modelOptions?: ModelOptionsMap,
  ) => Promise<Session | null>;
  steering?: boolean;
  lifecycleBusy?: boolean;
}

export function GridView(props: GridViewProps) {
  const { sessions, providers } = props;
  const [preset, setPreset] = useState<GridPreset>(() => loadGridPreference().preset);
  const [slots, setSlots] = useState<GridSlot[]>(() => loadGridPreference().slots);
  const [focusedSlot, setFocusedSlot] = useState<number | null>(null);
  const [maximizedSlot, setMaximizedSlot] = useState<number | null>(null);

  const persist = useCallback((nextPreset: GridPreset, nextSlots: GridSlot[]) => {
    saveGridPreference({ version: 1, preset: nextPreset, slots: nextSlots });
  }, []);

  const changePreset = useCallback(
    (next: GridPreset) => {
      setSlots((prev) => {
        const fitted = fitSlots(prev, next);
        persist(next, fitted);
        return fitted;
      });
      setPreset(next);
      // Keep focus valid: if the focused slot fell off the end, drop focus.
      setFocusedSlot((f) => (f !== null && f >= PRESET_SLOT_COUNT[next] ? null : f));
    },
    [persist],
  );

  const bindSlot = useCallback(
    (index: number, sessionId: string) => {
      setSlots((prev) => {
        const next = prev.map((s, i) => (i === index ? { sessionId } : s));
        persist(preset, next);
        return next;
      });
    },
    [persist, preset],
  );

  const sessionsById = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.id, s);
    return map;
  }, [sessions]);

  const boundSessionIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of slots) if (s.sessionId) set.add(s.sessionId);
    return set;
  }, [slots]);

  // Maximize: mount ONLY the full SessionDetail; every tile unmounts (founder-locked).
  if (maximizedSlot !== null) {
    const bound = slots[maximizedSlot]?.sessionId;
    const session = bound ? sessionsById.get(bound) : undefined;
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
          onRestoreGrid={() => setMaximizedSlot(null)}
        />
      );
    }
    // Bound session vanished while maximized — fall back to the grid.
    setMaximizedSlot(null);
  }

  return (
    <section className="flex flex-1 flex-col min-h-0 min-w-0">
      {/* Below md the grid is not usable — CSS-only gate, no JS redirect. */}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center md:hidden">
        <MonitorSmartphone className="size-8 text-muted-foreground" />
        <div>
          <h1 className="text-[17px] font-medium">The grid needs a desktop viewport</h1>
          <p className="mx-auto mt-1 max-w-[320px] text-[13px] text-muted-foreground">
            The multi-session workbench is built for a wide screen. Open a single session from the
            sidebar to keep working on this device.
          </p>
        </div>
      </div>

      <div className="hidden min-h-0 flex-1 flex-col md:flex">
        <header className="flex items-center gap-3 border-b border-border px-4 py-2.5 shrink-0">
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Workbench
            </span>
            <h1 className="text-[15px] font-medium leading-tight">Session grid</h1>
          </div>
          <div
            role="tablist"
            aria-label="Grid layout"
            className="ml-auto flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5"
          >
            {GRID_PRESETS.map((p) => (
              <button
                key={p}
                role="tab"
                type="button"
                aria-selected={preset === p}
                onClick={() => changePreset(p)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[12px] font-medium tabular-nums transition-colors',
                  'outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  preset === p
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </header>

        <div
          className="grid min-h-0 flex-1 gap-2.5 p-2.5"
          style={{
            gridTemplateColumns: `repeat(${PRESET_COLUMNS[preset]}, minmax(0, 1fr))`,
            gridAutoRows: 'minmax(0, 1fr)',
          }}
        >
          {slots.map((slot, index) => {
            const session = slot.sessionId ? sessionsById.get(slot.sessionId) : undefined;
            // Dead-session restore: a binding whose session is gone degrades to empty.
            if (slot.sessionId && !session) {
              return (
                <SlotComposerCell
                  key={index}
                  {...props}
                  boundSessionIds={boundSessionIds}
                  onBind={(id) => bindSlot(index, id)}
                />
              );
            }
            if (session) {
              const focused = focusedSlot === index;
              return (
                <SessionTile
                  key={session.id}
                  session={session}
                  focused={focused}
                  onFocus={() => setFocusedSlot(index)}
                  onMaximize={() => setMaximizedSlot(index)}
                  onSteer={focused ? (msg) => props.onSteerSession(session.id, msg) : undefined}
                  steering={props.steering}
                />
              );
            }
            return (
              <SlotComposerCell
                key={index}
                {...props}
                boundSessionIds={boundSessionIds}
                onBind={(id) => bindSlot(index, id)}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function SlotComposerCell({
  providers,
  sessions,
  boundSessionIds,
  onCreate,
  onBind,
}: GridViewProps & { boundSessionIds: Set<string>; onBind: (id: string) => void }) {
  return (
    <GridSlotComposer
      providers={providers}
      sessions={sessions}
      boundSessionIds={boundSessionIds}
      onCreate={async (prompt, model, provider, projectPath, baseBranch, modelOptions) => {
        const created = await onCreate(prompt, model, provider, projectPath, baseBranch, modelOptions);
        if (created) onBind(created.id);
        return created;
      }}
      onBind={onBind}
    />
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
  onRestoreGrid: () => void;
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
  onRestoreGrid,
}: MaximizedSessionProps) {
  // Same stream + active-run wiring SessionRoute uses; resumes via the hook's cursor.
  const { events, refetch } = useSessionStream(session.id);
  const machineActive = useActiveRun(session, { onTranscriptRefreshed: refetch });

  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      <div className="absolute right-3 top-2.5 z-20">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 shadow-sm"
          onClick={onRestoreGrid}
          aria-label="Restore grid"
        >
          <Minimize2 className="size-3.5" />
          Grid
        </Button>
      </div>
      <SessionDetail
        session={session}
        events={events}
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
