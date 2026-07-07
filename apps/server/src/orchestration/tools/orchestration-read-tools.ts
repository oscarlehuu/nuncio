import { renderEventsSince } from '../../context/events-compactor';
import { truncateHeadBytes } from '../byte-truncate';
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
const TITLE_MAX_BYTES = 256;
const ANCESTOR_WALK_CAP = 10;

function errorResult(reason: string): AgentRuntimeToolResult {
  return { content: [{ type: 'text', text: reason }], isError: true };
}

function ok(text: string, structuredContent: unknown): AgentRuntimeToolResult {
  return { content: [{ type: 'text', text }], structuredContent };
}

function capTitle(title: string): string {
  return truncateHeadBytes(title, TITLE_MAX_BYTES);
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

/**
 * A target session is visible to the caller when it shares a NON-NULL project
 * with the caller, or is in the caller's lineage (self / ancestor / child).
 * A null project matches nothing project-wise (so no-project sessions are not
 * mutually readable) — visibility then reduces to lineage only.
 */
function isVisible(deps: OrchestrationToolDeps, scope: OrchestrationScope, target: SessionDto): boolean {
  const sameProject =
    scope.projectPath !== null && target.projectPath !== null && target.projectPath === scope.projectPath;
  if (sameProject) return true;
  if (target.id === scope.sessionId) return true;
  if (ancestorIds(deps, scope.sessionId).has(target.id)) return true;
  return deps.childrenOf(scope.sessionId).some((c) => c.id === target.id);
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

const DISABLED = 'orchestration tools are disabled';

/** Re-read the current mode; return an isError result when read access is not permitted. */
function readGate(deps: OrchestrationToolDeps): AgentRuntimeToolResult | null {
  return deps.currentMode() === 'off' ? errorResult(DISABLED) : null;
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
      const gate = readGate(deps);
      if (gate) return gate;
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
        // A null caller project matches nothing project-wise — only its own
        // lineage stays visible; a project caller sees same-project rows.
        .filter((s) => (scope.projectPath !== null && s.projectPath === scope.projectPath) || ancestors.has(s.id) || childIds.has(s.id) || s.id === scope.sessionId)
        .filter((s) => (status ? s.status === status : true))
        .slice(0, limit)
        .map((s: SessionDto) => ({
          id: s.id,
          title: capTitle(s.title),
          status: s.status,
          provider: s.provider,
          branch: s.branch,
          updatedAt: s.updatedAt,
          isAncestor: ancestors.has(s.id),
          isChild: childIds.has(s.id),
        }));
      return ok(`${rows.length} session(s) visible`, rows);
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
      const gate = readGate(deps);
      if (gate) return gate;
      const input = asToolInput(raw);
      const targetId = typeof input.sessionId === 'string' ? input.sessionId : '';
      if (!targetId) return errorResult('sessionId is required');
      const target = deps.findSession(targetId);
      if (!target) return errorResult(`session ${targetId} not found`);
      if (!isVisible(deps, scope, target)) {
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
      const gate = readGate(deps);
      if (gate) return gate;
      const input = asToolInput(raw);
      const parentSessionId = typeof input.parentSessionId === 'string' ? input.parentSessionId : scope.sessionId;
      // A caller may only list tasks under a parent session it can see.
      if (parentSessionId !== scope.sessionId) {
        const parent = deps.findSession(parentSessionId);
        if (!parent || !isVisible(deps, scope, parent)) {
          return errorResult(`session ${parentSessionId} is outside your project and lineage`);
        }
      }
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
      const gate = readGate(deps);
      if (gate) return gate;
      const input = asToolInput(raw);
      const taskId = typeof input.taskId === 'string' ? input.taskId : '';
      if (!taskId) return errorResult('taskId is required');
      const task = deps.findTask(taskId);
      if (!task) return errorResult(`task ${taskId} not found`);
      // Scope guard: the task must belong to a session the caller can see —
      // either its parent session or its own child session.
      if (!taskVisible(deps, scope, task)) {
        return errorResult(`task ${taskId} is outside your project and lineage`);
      }
      const terminal = task.status === 'DONE' || task.status === 'FAILED' || task.status === 'CANCELLED';
      if (!terminal) return errorResult(`task ${taskId} is ${task.status}, not finished`);
      // Build the digest on demand (covers terminal tasks predating the digest event).
      const events = task.sessionId ? deps.listEventsSince(task.sessionId, 0, 500) : [];
      const payload = buildOutcomeDigest(task, task.sessionId, events, null);
      const briefGoal = task.contextBrief?.goal ?? null;
      return ok(`task ${task.status}`, { ...payload, briefGoal });
    },
  };

  const listProjectFacts: AgentRuntimeTool = {
    name: 'nuncio_list_project_facts',
    description: 'List the curated facts for this project (build commands, gotchas, standing decisions).',
    inputSchema: { type: 'object', properties: {} },
    execute: () => {
      const gate = readGate(deps);
      if (gate) return gate;
      if (!scope.projectPath) return ok('0 project fact(s)', []);
      const rows = deps.listProjectFacts(scope.projectPath);
      return ok(`${rows.length} project fact(s)`, rows);
    },
  };

  return [listSessions, readSession, listTasks, getTaskResult, listProjectFacts];
}

/** A task is visible when its parent session, or its own child session, is visible to the caller. */
function taskVisible(deps: OrchestrationToolDeps, scope: OrchestrationScope, task: { parentSessionId: string | null; sessionId: string | null }): boolean {
  for (const id of [task.parentSessionId, task.sessionId]) {
    if (!id) continue;
    const session = deps.findSession(id);
    if (session && isVisible(deps, scope, session)) return true;
  }
  return false;
}

function verifyPassedFromOutcome(outcome: Record<string, unknown> | null): boolean | null {
  const verify = outcome?.verify as { ok?: unknown } | undefined;
  return typeof verify?.ok === 'boolean' ? verify.ok : null;
}
