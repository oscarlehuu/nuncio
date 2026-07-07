import { asToolInput } from '../../agents/tools/agent-runtime-tools.types';
import type { AgentRuntimeTool, AgentRuntimeToolResult } from '../../agents/tools/agent-runtime-tools.types';
import { byteLength } from '../byte-truncate';
import type { HandoffBrief } from '../handoff-brief.types';
import type { OrchestrationScope, OrchestrationToolDeps } from './orchestration-tools.types';

const DEPTH_CAP = 2;
const OPEN_TASK_CAP = 10;
const INPUT_MAX_BYTES = 16 * 1024;
const VALID_TAGS = new Set(['mechanical', 'review', 'design', 'research']);
const ANCESTOR_WALK_CAP = 10;

function errorResult(reason: string): AgentRuntimeToolResult {
  return { content: [{ type: 'text', text: reason }], isError: true };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return items.length ? items : undefined;
}

/** Length of the caller's own ancestor chain (cycle-safe, capped). */
function callerChainDepth(deps: OrchestrationToolDeps, sessionId: string): number {
  let depth = 0;
  const visited = new Set<string>([sessionId]);
  let cursor = deps.findSession(sessionId)?.parentSessionId ?? null;
  while (cursor && depth < ANCESTOR_WALK_CAP && !visited.has(cursor)) {
    visited.add(cursor);
    depth += 1;
    cursor = deps.findSession(cursor)?.parentSessionId ?? null;
  }
  return depth;
}

export function buildEnqueueTool(
  deps: OrchestrationToolDeps,
  scope: OrchestrationScope,
): AgentRuntimeTool {
  return {
    name: 'nuncio_enqueue_task',
    description: 'Delegate a subagent task with an agent-authored brief. Returns the queued task id and resolved engine.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        brief: {
          type: 'object',
          properties: {
            goal: { type: 'string' },
            constraints: { type: 'array', items: { type: 'string' } },
            decisions: { type: 'array', items: { type: 'string' } },
            files: { type: 'array', items: { type: 'string' } },
            doneCriteria: { type: 'array', items: { type: 'string' } },
          },
          required: ['goal'],
        },
        tag: { type: 'string', enum: ['mechanical', 'review', 'design', 'research'] },
        provider: { type: 'string' },
        useWorktree: { type: 'boolean' },
      },
      required: ['prompt', 'brief'],
    },
    execute: async (raw) => {
      const input = asToolInput(raw);
      // Re-read the CURRENT mode: a mid-session flip to a mode that no longer
      // permits writes must be refused even on a long-lived provider handle.
      if (deps.currentMode() !== 'read-write') return errorResult('orchestration tools are disabled');

      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) return errorResult('prompt is required');
      const briefInput = asToolInput(input.brief);
      const goal = typeof briefInput.goal === 'string' ? briefInput.goal.trim() : '';
      if (!goal) return errorResult('brief.goal is required');

      const tag = typeof input.tag === 'string' ? input.tag : undefined;
      if (tag && !VALID_TAGS.has(tag)) {
        return errorResult(`tag must be one of: ${[...VALID_TAGS].join(', ')}`);
      }

      const explicitProvider = typeof input.provider === 'string' ? input.provider.trim() : undefined;

      // Size guard on the whole measured input: prompt + brief JSON + tag + provider.
      const measured =
        byteLength(prompt) +
        byteLength(JSON.stringify(briefInput)) +
        byteLength(tag ?? '') +
        byteLength(explicitProvider ?? '');
      if (measured > INPUT_MAX_BYTES) {
        return errorResult('prompt + brief exceed the 16KB limit');
      }

      const parent = deps.findSession(scope.sessionId);
      if (!parent) return errorResult('calling session not found');

      // Build the brief (the only async step) BEFORE the cap re-check, so the
      // caps are evaluated in the same synchronous tick as the insert.
      let workspace: HandoffBrief['workspace'] = null;
      try {
        workspace = await deps.buildWorkspaceSnapshot(parent);
      } catch {
        workspace = null; // best-effort; a snapshot failure never blocks delegation
      }
      const verifyCommand = deps.resolveVerifyCommand(parent) ?? undefined;
      const brief: HandoffBrief = {
        goal: goal.slice(0, 500),
        ...(stringArray(briefInput.constraints) ? { constraints: stringArray(briefInput.constraints) } : {}),
        ...(stringArray(briefInput.decisions) ? { decisions: stringArray(briefInput.decisions) } : {}),
        ...(stringArray(briefInput.files) ? { files: stringArray(briefInput.files) } : {}),
        ...(stringArray(briefInput.doneCriteria) ? { doneCriteria: stringArray(briefInput.doneCriteria) } : {}),
        ...(workspace ? { workspace } : {}),
        ...(verifyCommand ? { verifyCommand } : {}),
        sourceSessionId: scope.sessionId,
      };

      const defaults = deps.resolveSubagentDefaults(parent, explicitProvider || undefined);
      const useWorktree = input.useWorktree === false ? false : true;

      // Depth + open-task caps are re-evaluated HERE — after all awaits, in the
      // same synchronous tick as enqueueTask. In a single-threaded runtime no
      // other enqueue can interleave between this check and the insert, so N
      // parallel calls cannot each see 9-open and overshoot the cap.
      const childChainDepth = callerChainDepth(deps, scope.sessionId) + 1;
      if (childChainDepth >= DEPTH_CAP) {
        return errorResult(
          `delegation chain would reach depth ${childChainDepth} (cap ${DEPTH_CAP}); report your result to your parent instead of delegating further`,
        );
      }
      const open = deps
        .listTasks(scope.sessionId)
        .filter((t) => t.role === 'subagent' && (t.status === 'QUEUED' || t.status === 'RUNNING'));
      if (open.length >= OPEN_TASK_CAP) {
        return errorResult(`open subagent task cap reached (${OPEN_TASK_CAP}); wait for some to finish`);
      }

      const task = deps.enqueueTask({
        prompt,
        provider: defaults.provider,
        ...(defaults.model ? { model: defaults.model } : {}),
        parentSessionId: scope.sessionId,
        role: 'subagent',
        contextBrief: brief,
        useWorktree,
        ...(tag ? { tag } : {}),
        ...(parent.projectPath ? { projectPath: parent.projectPath } : {}),
      });

      const output = {
        taskId: task.id,
        resolvedProvider: defaults.provider,
        resolvedModel: defaults.model,
        queuePosition: deps.queuePosition(task.id),
      };
      return {
        content: [{ type: 'text', text: `Queued subagent task ${task.id} on ${defaults.provider} (position ${output.queuePosition}).` }],
        structuredContent: output,
      };
    },
  };
}
