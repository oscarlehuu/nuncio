import { byteLength, truncateHeadBytes } from '../../orchestration/byte-truncate';
import { truncateExternalMemory } from './external-memories';

export const EXTERNAL_MEMORY_TOOL_NAME = 'read_external_memory';
export const EXTERNAL_MEMORY_READ_MAX_BYTES = 24576;

const RESULT_TRUNCATED = '_(external memory truncated)_';
const AVAILABLE_IDS_MAX_BYTES = 2048;

export type ExternalMemorySourceId = 'claude-code' | 'codex';

export interface ExternalMemoryToolDeps {
  availableIds(source: ExternalMemorySourceId): string[];
  read(source: ExternalMemorySourceId, id: string): Promise<string | null>;
}

const PARAMETERS = {
  type: 'object',
  properties: {
    source: {
      type: 'string',
      enum: ['claude-code', 'codex'],
      description: 'The external agent store that owns this memory.',
    },
    id: {
      type: 'string',
      description: 'An id shown in the External agent memories index.',
    },
  },
  required: ['source', 'id'],
};

function validId(id: string): boolean {
  return id.length > 0
    && !id.includes('..')
    && !id.includes('/')
    && !id.includes('\\')
    && !id.includes('\0');
}

function error(text: string) {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    details: {},
  };
}

function unknownIdText(source: ExternalMemorySourceId, id: string, ids: string[]): string {
  const prefix = `Unknown ${source} memory id "${id}". Available ids: `;
  const list = ids.length > 0 ? ids.join(', ') : '(none)';
  const available = byteLength(prefix) >= AVAILABLE_IDS_MAX_BYTES
    ? ''
    : truncateHeadBytes(list, AVAILABLE_IDS_MAX_BYTES - byteLength(prefix));
  return `${prefix}${available}`;
}

/** A session-bound, read-only view over ids advertised in the external-memory index. */
export function buildExternalMemoryTool(
  deps: ExternalMemoryToolDeps,
  defineTool?: (tool: unknown) => unknown,
): unknown {
  const wrap = defineTool ?? ((tool: unknown) => tool);
  return wrap({
    name: EXTERNAL_MEMORY_TOOL_NAME,
    label: 'Read external memory',
    description:
      'Read one project-relevant memory from the read-only Claude Code or Codex CLI memory store. Use only ids shown in the External agent memories index.',
    promptSnippet: 'read_external_memory: open a memory listed in the external-memory index.',
    parameters: PARAMETERS,
    execute: async (_toolCallId: string, params: unknown) => {
      const source = (params as { source?: unknown })?.source;
      const id = (params as { id?: unknown })?.id;
      if (source !== 'claude-code' && source !== 'codex') {
        return error('Invalid external memory source. Use claude-code or codex.');
      }
      if (typeof id !== 'string' || !validId(id)) {
        return error('Rejected invalid memory id. Use an id from the injected index.');
      }
      const availableIds = deps.availableIds(source);
      if (!availableIds.includes(id)) return error(unknownIdText(source, id, availableIds));
      const content = await deps.read(source, id);
      if (content === null) return error(unknownIdText(source, id, availableIds));
      return {
        content: [{
          type: 'text',
          text: truncateExternalMemory(content, EXTERNAL_MEMORY_READ_MAX_BYTES, RESULT_TRUNCATED),
        }],
        details: {},
      };
    },
  });
}
