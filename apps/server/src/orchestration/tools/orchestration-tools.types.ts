import type { AgentRuntimeTool } from '../../agents/tools/agent-runtime-tools.types';
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
  resolveSubagentDefaults(parent: SessionDto, explicitProvider?: string): {
    provider: string;
    model: string | null;
  };
  /** A3 workspace snapshot for the parent, merged into an agent-authored brief. */
  buildWorkspaceSnapshot(parent: SessionDto): Promise<HandoffBrief['workspace']>;
  /** A2 verify-command resolution for the parent workspace. */
  resolveVerifyCommand(parent: SessionDto): string | null;
}

export type OrchestrationTool = AgentRuntimeTool;
