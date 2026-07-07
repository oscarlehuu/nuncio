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
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) return errorResult('prompt is required');
      const briefInput = asToolInput(input.brief);
      const goal = typeof briefInput.goal === 'string' ? briefInput.goal.trim() : '';
      if (!goal) return errorResult('brief.goal is required');

      const tag = typeof input.tag === 'string' ? input.tag : undefined;
      if (tag && !VALID_TAGS.has(tag)) {
        return errorResult(`tag must be one of: ${[...VALID_TAGS].join(', ')}`);
      }

      // Size guard on the whole payload (prompt + brief).
      if (byteLength(prompt) + byteLength(JSON.stringify(briefInput)) > INPUT_MAX_BYTES) {
        return errorResult('prompt + brief exceed the 16KB limit');
      }

      const parent = deps.findSession(scope.sessionId);
      if (!parent) return errorResult('calling session not found');

      // Depth guard: the child-to-be's chain = caller chain + 1. Reject at ≥ cap
      // so an agent two levels deep reports to its parent instead of delegating.
      const childChainDepth = callerChainDepth(deps, scope.sessionId) + 1;
      if (childChainDepth >= DEPTH_CAP) {
        return errorResult(
          `delegation chain would reach depth ${childChainDepth} (cap ${DEPTH_CAP}); report your result to your parent instead of delegating further`,
        );
      }

      // Open-task cap per parent (QUEUED or RUNNING subagents).
      const open = deps
        .listTasks(scope.sessionId)
        .filter((t) => t.role === 'subagent' && (t.status === 'QUEUED' || t.status === 'RUNNING'));
      if (open.length >= OPEN_TASK_CAP) {
        return errorResult(`open subagent task cap reached (${OPEN_TASK_CAP}); wait for some to finish`);
      }

      // Merge agent intent with nuncio ground truth (workspace snapshot + verify).
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

      const explicitProvider = typeof input.provider === 'string' ? input.provider.trim() : undefined;
      const defaults = deps.resolveSubagentDefaults(parent, explicitProvider || undefined);
      const useWorktree = input.useWorktree === false ? false : true;

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
