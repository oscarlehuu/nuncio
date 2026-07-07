import { renderEventsSince } from '../../context/events-compactor';
import { buildOutcomeDigest } from '../outcome-digest.builder';
import { asToolInput } from '../../agents/tools/agent-runtime-tools.types';
import type { AgentRuntimeTool, AgentRuntimeToolResult } from '../../agents/tools/agent-runtime-tools.types';
import type { SessionDto, SessionEvent } from '../../sessions/domain/sessions.types';
import type { OrchestrationScope, OrchestrationToolDeps } from './orchestration-tools.types';

const LIST_LIMIT_MAX = 20;
const LIST_LIMIT_DEFAULT = 10;
const READ_BUDGET_MAX = 8192;
const READ_BUDGET_DEFAULT = 4096;
const TASK_PROMPT_PREVIEW = 120;
const ANCESTOR_WALK_CAP = 10;

function errorResult(reason: string): AgentRuntimeToolResult {
  return { content: [{ type: 'text', text: reason }], isError: true };
}

function ok(text: string, structuredContent: unknown): AgentRuntimeToolResult {
  return { content: [{ type: 'text', text }], structuredContent };
}

/** Ancestor ids of a session, cycle-safe, capped — reuses the A6 walk shape. */
function ancestorIds(deps: OrchestrationToolDeps, sessionId: string): Set<string> {
  const ids = new Set<string>();
  const visited = new Set<string>([sessionId]);
  let cursor = deps.findSession(sessionId)?.parentSessionId ?? null;
  while (cursor && ids.size < ANCESTOR_WALK_CAP && !visited.has(cursor)) {
    visited.add(cursor);
    ids.add(cursor);
    cursor = deps.findSession(cursor)?.parentSessionId ?? null;
  }
  return ids;
}

function lastVerifyResult(events: SessionEvent[]): { passed: boolean } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'verify_result') continue;
    const ok = (event.payload as { ok?: unknown } | null)?.ok;
    if (typeof ok === 'boolean') return { passed: ok };
  }
  return null;
}

export function buildReadTools(
  deps: OrchestrationToolDeps,
  scope: OrchestrationScope,
): AgentRuntimeTool[] {
  const listSessions: AgentRuntimeTool = {
    name: 'nuncio_list_sessions',
    description: 'List sibling sessions in this project (compact rows: id, title, status, provider, branch).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['RUNNING', 'IDLE', 'PAUSED', 'ERROR'] },
        limit: { type: 'number', minimum: 1, maximum: LIST_LIMIT_MAX },
      },
    },
    execute: (raw) => {
      const input = asToolInput(raw);
      const status = typeof input.status === 'string' ? input.status : undefined;
      const limit = Math.min(
        LIST_LIMIT_MAX,
        Math.max(1, Number.isFinite(input.limit) ? Number(input.limit) : LIST_LIMIT_DEFAULT),
      );
      const ancestors = ancestorIds(deps, scope.sessionId);
      const childIds = new Set(deps.childrenOf(scope.sessionId).map((c) => c.id));
      const rows = deps
        .listSessions()
        .filter((s) => s.projectPath === scope.projectPath)
        .filter((s) => (status ? s.status === status : true))
        .slice(0, limit)
        .map((s: SessionDto) => ({
          id: s.id,
          title: s.title,
          status: s.status,
          provider: s.provider,
          branch: s.branch,
          updatedAt: s.updatedAt,
          isAncestor: ancestors.has(s.id),
          isChild: childIds.has(s.id),
        }));
      return ok(`${rows.length} session(s) in project`, rows);
    },
  };

  const readSession: AgentRuntimeTool = {
    name: 'nuncio_read_session',
    description: 'Read a compact, budgeted slice of another session\'s history (summaries first; use sinceSeq to go deeper).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        sinceSeq: { type: 'number', minimum: 0 },
        budgetBytes: { type: 'number', minimum: 256, maximum: READ_BUDGET_MAX },
      },
      required: ['sessionId'],
    },
    execute: (raw) => {
      const input = asToolInput(raw);
      const targetId = typeof input.sessionId === 'string' ? input.sessionId : '';
      if (!targetId) return errorResult('sessionId is required');
      const target = deps.findSession(targetId);
      if (!target) return errorResult(`session ${targetId} not found`);
      const sameProject = target.projectPath === scope.projectPath;
      const inLineage = ancestorIds(deps, scope.sessionId).has(targetId) ||
        deps.childrenOf(scope.sessionId).some((c) => c.id === targetId) ||
        targetId === scope.sessionId;
      if (!sameProject && !inLineage) {
        return errorResult(`session ${targetId} is outside your project and lineage`);
      }
      const sinceSeq = Number.isFinite(input.sinceSeq) ? Math.max(0, Number(input.sinceSeq)) : 0;
      const budget = Math.min(
        READ_BUDGET_MAX,
        Math.max(256, Number.isFinite(input.budgetBytes) ? Number(input.budgetBytes) : READ_BUDGET_DEFAULT),
      );
      const events = deps.listEventsSince(targetId, sinceSeq, 500);
      const text = renderEventsSince(events, budget, { sessionId: targetId, sinceSeq });
      const lastSeq = events.length ? events[events.length - 1]!.seq : sinceSeq;
      return ok(text, { status: target.status, lastSeq, verify: lastVerifyResult(events) });
    },
  };

  const listTasks: AgentRuntimeTool = {
    name: 'nuncio_list_tasks',
    description: 'List delegated tasks (defaults to this session\'s own subagents).',
    inputSchema: {
      type: 'object',
      properties: { parentSessionId: { type: 'string' } },
    },
    execute: (raw) => {
      const input = asToolInput(raw);
      const parentSessionId = typeof input.parentSessionId === 'string' ? input.parentSessionId : scope.sessionId;
      const rows = deps.listTasks(parentSessionId).map((t) => ({
        id: t.id,
        status: t.status,
        prompt: t.prompt.slice(0, TASK_PROMPT_PREVIEW),
        sessionId: t.sessionId,
        verifyPassed: verifyPassedFromOutcome(t.outcome),
        finishedAt: t.finishedAt,
      }));
      return ok(`${rows.length} task(s)`, rows);
    },
  };

  const getTaskResult: AgentRuntimeTool = {
    name: 'nuncio_get_task_result',
    description: 'Get the completion digest of a delegated task (status, verify, outcome summary, branch).',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
    execute: (raw) => {
      const input = asToolInput(raw);
      const taskId = typeof input.taskId === 'string' ? input.taskId : '';
      if (!taskId) return errorResult('taskId is required');
      const task = deps.findTask(taskId);
      if (!task) return errorResult(`task ${taskId} not found`);
      const terminal = task.status === 'DONE' || task.status === 'FAILED' || task.status === 'CANCELLED';
      if (!terminal) return errorResult(`task ${taskId} is ${task.status}, not finished`);
      // Build the digest on demand (covers terminal tasks predating the digest event).
      const events = task.sessionId ? deps.listEventsSince(task.sessionId, 0, 500) : [];
      const payload = buildOutcomeDigest(task, task.sessionId, events, null);
      const briefGoal = task.contextBrief?.goal ?? null;
      return ok(`task ${task.status}`, { ...payload, briefGoal });
    },
  };

  return [listSessions, readSession, listTasks, getTaskResult];
}

function verifyPassedFromOutcome(outcome: Record<string, unknown> | null): boolean | null {
  const verify = outcome?.verify as { ok?: unknown } | undefined;
  return typeof verify?.ok === 'boolean' ? verify.ok : null;
}
