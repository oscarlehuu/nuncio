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

const FACT_RECORDING_PROMPT_APPEND =
  'When you discover a durable, project-specific fact a future session would otherwise re-derive ' +
  '(a build/test command, a convention, a gotcha, a standing decision, a problem→solution pair), ' +
  'record it with nuncio_record_project_fact (kebab-case key, one context-free sentence as the ' +
  'value). Recorded facts are injected into every future session on this project. Do not record ' +
  'task-specific or transient details.';

/**
 * Build the orchestration runtime tools for a session, gated by mode. `off`
 * yields no fleet tools; `read` yields the read-only tools; `read-write` adds
 * nuncio_enqueue_task. Standalone fact recording (`factRecording`, default-on
 * via NUNCIO_FACT_RECORDING) contributes nuncio_record_project_fact — and its
 * prompt nudge — independently of the orchestration mode, so project knowledge
 * compounds even with the fleet tools off. The factory is pure over its deps
 * (repositories + callbacks), so it has no path back to the tool registry.
 */
export function buildOrchestrationTools(
  deps: OrchestrationToolDeps,
  scope: OrchestrationScope,
  mode: OrchestrationMode,
  /** D2: profile `tools-preamble` overrides the default systemPromptAppend when present. */
  toolsPreamble?: string,
): AgentRuntimeTools {
  const includeFactTool = mode === 'read-write' || deps.factRecordingEnabled();
  if (mode === 'off' && !includeFactTool) return { tools: [] };

  const tools: AgentRuntimeTool[] = mode === 'off' ? [] : buildReadTools(deps, scope);
  if (mode === 'read-write') tools.push(buildEnqueueTool(deps, scope));
  if (includeFactTool) tools.push(buildRecordFactTool(deps, scope));

  const appends: string[] = [];
  if (mode !== 'off') appends.push(toolsPreamble?.trim() || SYSTEM_PROMPT_APPEND);
  if (includeFactTool) appends.push(FACT_RECORDING_PROMPT_APPEND);
  return { systemPromptAppend: appends.join('\n\n'), tools };
}
