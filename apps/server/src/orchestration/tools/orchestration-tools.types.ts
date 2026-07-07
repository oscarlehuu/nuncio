import type { AgentRuntimeTool } from '../../agents/tools/agent-runtime-tools.types';
import type { ContextFactDto } from '../../context/context-facts.types';
import type { HandoffBrief } from '../handoff-brief.types';
import type { SessionDto, SessionEvent } from '../../sessions/domain/sessions.types';
import type { CreateTaskDto, TaskDto } from '../../tasks/tasks.types';

export type OrchestrationMode = 'off' | 'read' | 'read-write';

/** Where a tool call is anchored: the calling session and its project. */
export interface OrchestrationScope {
  sessionId: string;
  projectPath: string | null;
}

/**
 * Narrow capability surface the tools need — deliberately repositories + a
 * couple of callbacks, never SessionsService/TasksService directly, so the
 * factory has no path back to the tool registry (no DI cycle).
 */
export interface OrchestrationToolDeps {
  /**
   * The CURRENT gating mode, re-read on every tool call. Long-lived provider
   * handles register tools once, so a mid-session mode flip is enforced here at
   * execute time — not only at registration.
   */
  currentMode(): OrchestrationMode;
  listSessions(): SessionDto[];
  findSession(id: string): SessionDto | null;
  childrenOf(parentSessionId: string): SessionDto[];
  listEventsSince(sessionId: string, since: number, limit: number): SessionEvent[];
  listTasks(parentSessionId?: string): TaskDto[];
  findTask(id: string): TaskDto | null;
  /** Enqueue a subagent task (creates the row and triggers the pump). */
  enqueueTask(input: CreateTaskDto): TaskDto;
  /** Number of QUEUED tasks ahead of a freshly-enqueued one (1-based position). */
  queuePosition(taskId: string): number;
  /** Resolve the effective provider/model for a subagent under a parent session. */
  /**
   * Resolve the child engine via the shared order: explicit provider > tag
   * routing > subagent defaults. Async because tag routing consults live
   * provider availability.
   */
  resolveEngine(parent: SessionDto, explicitProvider?: string, tag?: string): Promise<{
    provider: string;
    model: string | null;
  }>;
  /** A3 workspace snapshot for the parent, merged into an agent-authored brief. */
  buildWorkspaceSnapshot(parent: SessionDto): Promise<HandoffBrief['workspace']>;
  /** A2 verify-command resolution for the parent workspace. */
  resolveVerifyCommand(parent: SessionDto): string | null;
  /** B1 facts for the caller's project. */
  listProjectFacts(projectPath: string): ContextFactDto[];
  /**
   * Record an agent-provenance fact (B3 rules apply). Returns the write outcome:
   * `written` (direct), `proposed` (rejected → pending founder review), or a
   * validation `error` message.
   */
  recordProjectFact(input: {
    projectPath: string;
    key: string;
    value: string;
    sourceSessionId: string;
  }): { status: 'written' | 'proposed' | 'error'; message: string };
}

export type OrchestrationTool = AgentRuntimeTool;
