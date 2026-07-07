import type { AgentRuntimeTool, AgentRuntimeTools } from '../../agents/tools/agent-runtime-tools.types';
import { buildEnqueueTool } from './orchestration-enqueue-tool';
import { buildReadTools } from './orchestration-read-tools';
import { buildRecordFactTool } from './orchestration-record-fact-tool';
import type { OrchestrationMode, OrchestrationScope, OrchestrationToolDeps } from './orchestration-tools.types';

const SYSTEM_PROMPT_APPEND =
  'You can observe and delegate across the Nuncio session fleet with the nuncio_* tools. ' +
  'Fetch context progressively — never ask for a full transcript: nuncio_list_sessions and ' +
  'nuncio_list_tasks give one-line summaries; nuncio_get_task_result gives a task digest; escalate ' +
  'to nuncio_read_session with a sinceSeq to pull a compact, budgeted slice of a specific session ' +
  'only when a summary is not enough. When read-write is enabled, nuncio_enqueue_task delegates a ' +
  'subagent with a brief you author; its result returns to your transcript as a digest.';

/**
 * Build the orchestration runtime tools for a session, gated by mode. `off`
 * yields no tools and no prompt append (they are absent entirely); `read` yields
 * the four read-only tools; `read-write` adds nuncio_enqueue_task. The factory is
 * pure over its deps (repositories + callbacks), so it has no path back to the
 * tool registry.
 */
export function buildOrchestrationTools(
  deps: OrchestrationToolDeps,
  scope: OrchestrationScope,
  mode: OrchestrationMode,
): AgentRuntimeTools {
  if (mode === 'off') return { tools: [] };

  const tools: AgentRuntimeTool[] = buildReadTools(deps, scope);
  if (mode === 'read-write') {
    tools.push(buildEnqueueTool(deps, scope));
    tools.push(buildRecordFactTool(deps, scope));
  }

  return { systemPromptAppend: SYSTEM_PROMPT_APPEND, tools };
}
