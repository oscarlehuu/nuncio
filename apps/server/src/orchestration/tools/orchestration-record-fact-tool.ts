import { asToolInput } from '../../agents/tools/agent-runtime-tools.types';
import type { AgentRuntimeTool, AgentRuntimeToolResult } from '../../agents/tools/agent-runtime-tools.types';
import type { OrchestrationScope, OrchestrationToolDeps } from './orchestration-tools.types';

function errorResult(reason: string): AgentRuntimeToolResult {
  return { content: [{ type: 'text', text: reason }], isError: true };
}

/**
 * nuncio_record_project_fact (read-write tier). Provenance is forced to `agent`
 * and the source session is the caller. The B3 rules decide the outcome: a
 * direct write, a pending proposal (when it would overwrite a founder fact), or
 * a validation error. The result text distinguishes the three.
 */
export function buildRecordFactTool(
  deps: OrchestrationToolDeps,
  scope: OrchestrationScope,
): AgentRuntimeTool {
  return {
    name: 'nuncio_record_project_fact',
    description: 'Record a durable project fact (kebab-case key, ≤1KB value). Founder facts are never overwritten — a conflicting write becomes a proposal pending founder review.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['key', 'value'],
    },
    execute: (raw) => {
      if (deps.currentMode() !== 'read-write') return errorResult('orchestration tools are disabled');
      if (!scope.projectPath) return errorResult('this session has no project to record facts for');
      const input = asToolInput(raw);
      const key = typeof input.key === 'string' ? input.key : '';
      const value = typeof input.value === 'string' ? input.value : '';

      const result = deps.recordProjectFact({
        projectPath: scope.projectPath,
        key,
        value,
        sourceSessionId: scope.sessionId,
      });

      if (result.status === 'error') return errorResult(result.message);
      return {
        content: [{ type: 'text', text: result.message }],
        structuredContent: { status: result.status, key },
      };
    },
  };
}
