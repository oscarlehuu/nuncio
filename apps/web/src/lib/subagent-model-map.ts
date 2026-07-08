/** Serialization for the NUNCIO_SUBAGENT_MODELS setting: a JSON object mapping
 *  providerId -> default subagent modelId. An empty selection for a provider is
 *  an OMITTED key (not an empty string), so the server falls back to its own
 *  per-provider default / the legacy NUNCIO_SUBAGENT_MODEL global. */

export type SubagentModelMap = Record<string, string>;

/** Parse the stored setting value into a map. Tolerates null/blank/malformed
 *  input (returns {}), since the setting may be unset or hand-edited. */
export function parseSubagentModelMap(raw: string | null | undefined): SubagentModelMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: SubagentModelMap = {};
  for (const [providerId, modelId] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof modelId === 'string' && modelId.trim()) out[providerId] = modelId;
  }
  return out;
}

/** Apply one provider's selection to the map and return the next map. A blank /
 *  undefined modelId clears that provider's override (drops the key). */
export function setSubagentModel(
  map: SubagentModelMap,
  providerId: string,
  modelId: string | null | undefined,
): SubagentModelMap {
  const next = { ...map };
  if (modelId && modelId.trim()) next[providerId] = modelId;
  else delete next[providerId];
  return next;
}

/** Serialize back to the stored form. An empty map serializes to '' so the
 *  setting reads as "unset" rather than a literal '{}'. */
export function serializeSubagentModelMap(map: SubagentModelMap): string {
  const keys = Object.keys(map);
  if (keys.length === 0) return '';
  // Stable key order keeps the stored value diff-friendly.
  const ordered: SubagentModelMap = {};
  for (const key of keys.sort()) ordered[key] = map[key];
  return JSON.stringify(ordered);
}
