import type { SubscriptionBridgeModel, SubscriptionBridgeSource } from './subscription-bridge.types';

interface OpenAiModelEntry {
  id?: unknown;
  display_name?: unknown;
  owned_by?: unknown;
}

interface OpenAiModelsResponse {
  data?: unknown;
}

/** Classify CLIProxyAPI /v1/models entries by owned_by (and id heuristics as fallback). */
export function classifyBridgeSource(ownedBy: string | undefined, id: string): SubscriptionBridgeSource {
  const owner = (ownedBy ?? '').toLowerCase();
  if (owner === 'openai' || owner.includes('codex')) return 'codex-sub';
  if (owner === 'anthropic' || owner === 'antigravity') return 'claude-sub';
  if (/^(gpt-|o[0-9]|codex-)/i.test(id)) return 'codex-sub';
  if (/^claude/i.test(id) || /^anthropic/i.test(id)) return 'claude-sub';
  return 'other';
}

/** True when a Claude-engine model id (prefix already stripped) must route via the bridge. */
export function isCodexBridgeModelId(modelId: string): boolean {
  const id = modelId.trim();
  if (!id) return false;
  return /^(gpt-|o[0-9]|codex-)/i.test(id);
}

/**
 * Parse OpenAI-compatible GET /v1/models JSON into bridge catalog rows.
 * Prefers OpenAI-format ids (gpt-*) over Anthropic cloaked ids.
 */
export function parseBridgeModelsResponse(body: unknown): SubscriptionBridgeModel[] {
  const data = (body as OpenAiModelsResponse)?.data;
  if (!Array.isArray(data)) return [];

  const out: SubscriptionBridgeModel[] = [];
  const seen = new Set<string>();

  for (const raw of data) {
    const entry = raw as OpenAiModelEntry;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) continue;
    // Skip Anthropic-format cloaked reverse-ids when a cleaner openai id exists later;
    // keep cloaked rows only when they look like real Claude models.
    const ownedBy = typeof entry.owned_by === 'string' ? entry.owned_by : undefined;
    const source = classifyBridgeSource(ownedBy, id);
    const displayName =
      typeof entry.display_name === 'string' && entry.display_name.trim()
        ? entry.display_name.trim()
        : id;
    seen.add(id);
    out.push({ id, displayName, source, ...(ownedBy ? { ownedBy } : {}) });
  }

  return out;
}

/** Codex-subscription models suitable for the Claude engine picker (OpenAI-shaped ids). */
export function codexModelsForClaudePicker(models: SubscriptionBridgeModel[]): SubscriptionBridgeModel[] {
  return models.filter(
    (model) =>
      model.source === 'codex-sub' &&
      isCodexBridgeModelId(model.id) &&
      // Drop image/video specialty models from the coding picker.
      !/image|video|imagine/i.test(model.id) &&
      !/image|video|imagine/i.test(model.displayName),
  );
}
