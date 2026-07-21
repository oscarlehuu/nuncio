/**
 * Pure ACP → Nuncio mappings for the Devin provider.
 * Keeps tool/permission translation unit-testable without spawning `devin acp`.
 */

interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpToolCallLike {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  content?: unknown;
}

const KIND_TO_TOOL: Record<string, string> = {
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'grep',
  execute: 'exec',
  think: 'think',
  fetch: 'fetch',
  other: 'tool',
};

/** Shared tool_start/tool_end payload from an ACP tool_call(_update). */
export function mapAcpToolCall(update: AcpToolCallLike): {
  callId: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
} | null {
  const callId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
  if (!callId) return null;

  const raw =
    update.rawInput && typeof update.rawInput === 'object' && !Array.isArray(update.rawInput)
      ? (update.rawInput as Record<string, unknown>)
      : undefined;
  const hasRawFields = Boolean(raw && Object.keys(raw).length > 0);
  const rawTool = typeof raw?.tool === 'string' ? raw.tool : undefined;
  const kind = typeof update.kind === 'string' ? update.kind : undefined;
  const tool = rawTool || (kind ? (KIND_TO_TOOL[kind] ?? kind) : undefined) || 'tool';

  const titleInput =
    typeof update.title === 'string' && update.title.trim()
      ? kind === 'execute' || tool === 'exec'
        ? { command: update.title.trim() }
        : { title: update.title.trim() }
      : undefined;
  const input = hasRawFields ? raw : titleInput;

  const mapped: {
    callId: string;
    tool: string;
    input?: unknown;
    output?: unknown;
    isError?: boolean;
  } = { callId, tool };
  if (input !== undefined) mapped.input = input;
  if (update.status === 'failed') mapped.isError = true;
  if (update.content !== undefined) mapped.output = update.content;
  return mapped;
}

/** Whether an ACP tool_call_update should seal the open tool row. */
export function isAcpToolTerminal(status: unknown): boolean {
  return status === 'completed' || status === 'failed';
}

/**
 * Map Nuncio's binary approve/deny onto an ACP request_permission result.
 * Prefer allow_once / reject_once; fall back to any allow_* / reject_*; else cancel.
 */
export function mapPermissionDecision(
  decision: 'approve' | 'deny',
  params: unknown,
): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  const options = permissionOptions(params);
  if (decision === 'approve') {
    const option =
      options.find((o) => o.kind === 'allow_once') ??
      options.find((o) => o.kind.startsWith('allow'));
    if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
    return { outcome: { outcome: 'cancelled' } };
  }
  const option =
    options.find((o) => o.kind === 'reject_once') ??
    options.find((o) => o.kind.startsWith('reject'));
  if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
  return { outcome: { outcome: 'cancelled' } };
}

function permissionOptions(params: unknown): AcpPermissionOption[] {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  const options = (params as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.optionId !== 'string' ||
      typeof record.name !== 'string' ||
      typeof record.kind !== 'string'
    ) {
      return [];
    }
    return [{ optionId: record.optionId, name: record.name, kind: record.kind }];
  });
}
