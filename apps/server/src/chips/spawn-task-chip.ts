import type { AttentionItemDto } from '../attention/attention.types';
import type { ChipDismisser, ChipDto, ChipPayload, ChipStatus } from './chips.types';

/** Dedup key: one OPEN chip per (source session, title+prompt hash). */
export function chipSubjectId(sourceSessionId: string, ref: string): string {
  return `${sourceSessionId}:${ref}`;
}

const STATUSES: readonly ChipStatus[] = ['proposed', 'acted', 'dismissed'];
const DISMISSERS: readonly ChipDismisser[] = ['user', 'agent'];

/**
 * Read the typed chip payload off an attention item, tolerating a legacy or
 * malformed shape by returning null (the caller drops it rather than throwing).
 */
function parseChipPayload(payload: Record<string, unknown> | null): ChipPayload | null {
  if (!payload) return null;
  const ref = str(payload.ref);
  const sourceSessionId = str(payload.sourceSessionId);
  const tldr = str(payload.tldr);
  const prompt = str(payload.prompt);
  if (!ref || !sourceSessionId || !prompt) return null;
  const status = STATUSES.includes(payload.status as ChipStatus)
    ? (payload.status as ChipStatus)
    : 'proposed';
  const dismissedBy = DISMISSERS.includes(payload.dismissedBy as ChipDismisser)
    ? (payload.dismissedBy as ChipDismisser)
    : undefined;
  return {
    ref,
    sourceSessionId,
    tldr,
    prompt,
    cwd: str(payload.cwd) || null,
    status,
    ...(dismissedBy ? { dismissedBy } : {}),
    ...(str(payload.dismissReason) ? { dismissReason: str(payload.dismissReason) } : {}),
    ...(str(payload.childSessionId) ? { childSessionId: str(payload.childSessionId) } : {}),
  };
}

/** Project an attention item into a ChipDto, or null when it is not a valid chip. */
export function chipFromAttentionItem(item: AttentionItemDto): ChipDto | null {
  const parsed = parseChipPayload(item.payload);
  if (!parsed) return null;
  return {
    id: item.id,
    ref: parsed.ref,
    sourceSessionId: parsed.sourceSessionId,
    title: item.title,
    tldr: parsed.tldr,
    prompt: parsed.prompt,
    cwd: parsed.cwd,
    projectPath: item.projectPath,
    status: parsed.status,
    dismissedBy: parsed.dismissedBy ?? null,
    dismissReason: parsed.dismissReason ?? null,
    childSessionId: parsed.childSessionId ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
