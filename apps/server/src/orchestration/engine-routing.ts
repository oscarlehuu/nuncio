/**
 * Deterministic tag → engine routing (dispatcher-lite). Data, not code: the
 * NUNCIO_ENGINE_ROUTING settings JSON maps a tag to a provider/model, optionally
 * requiring a different engine than the delegating session's. A routing table
 * must never strand a task, so any miss/unavailability/malformed input yields
 * null and callers fall through to their existing defaults.
 */

export interface EngineRoute {
  provider?: string;
  model?: string;
  /** Route to a different engine than the delegating session's provider. */
  avoidAuthorProvider?: boolean;
}

export interface EngineRoutingDeps {
  /** The raw NUNCIO_ENGINE_ROUTING settings value (JSON string), or undefined. */
  routingJson: string | undefined;
  /** Ids of providers currently available (AgentRegistry.available()). */
  availableProviderIds(): Promise<string[]>;
}

type RoutingTable = Record<string, EngineRoute>;

function parseTable(json: string | undefined): RoutingTable | null {
  const trimmed = json?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as RoutingTable;
  } catch {
    // Never throw on a hand-edited setting; one warning, then fall through.
    console.warn('[engine-routing] NUNCIO_ENGINE_ROUTING is not valid JSON; ignoring the routing table.');
    return null;
  }
}

/**
 * Resolve a routing decision for `tag`. Returns the routed `{ provider, model }`
 * or null (fall through to defaults). Null on: no tag, no table, unknown tag,
 * an entry with no provider, a routed provider that is unavailable, or malformed
 * JSON. `avoidAuthorProvider` swaps to the first OTHER available provider when
 * the route lands on the author's own provider; if none exists it keeps the
 * routed one and logs a note.
 */
export async function resolveRoute(
  tag: string | undefined,
  authorProvider: string,
  deps: EngineRoutingDeps,
): Promise<{ provider?: string; model?: string } | null> {
  if (!tag) return null;
  const table = parseTable(deps.routingJson);
  if (!table) return null;

  const route = table[tag];
  if (!route || typeof route.provider !== 'string' || !route.provider.trim()) return null;

  const available = new Set(await deps.availableProviderIds());
  let provider = route.provider.trim();
  let model = typeof route.model === 'string' && route.model.trim() ? route.model.trim() : undefined;

  // Availability check: never strand a task on an unroutable engine.
  if (!available.has(provider)) return null;

  if (route.avoidAuthorProvider && provider === authorProvider) {
    const other = [...available].find((id) => id !== authorProvider);
    if (other) {
      provider = other;
      // The routed model belongs to the avoided provider; drop it on a swap.
      model = undefined;
    } else {
      console.warn(
        `[engine-routing] tag "${tag}" wants a non-author engine but only ${authorProvider} is available; keeping it.`,
      );
    }
  }

  return { provider, ...(model ? { model } : {}) };
}

export interface ResolveEngineInput {
  /** Explicit provider override — always wins over routing. */
  explicitProvider?: string;
  /** Routing tag; drives resolveRoute when no explicit provider is given. */
  tag?: string;
  /** The delegating session's provider (author) — used by avoidAuthorProvider. */
  authorProvider: string;
  /** Fallback provider/model when neither explicit nor a route applies. */
  defaultProvider: string;
  defaultModel: string | null;
}

/**
 * The single shared resolution order for a task's engine, used by BOTH the
 * enqueue tool and POST /api/tasks: explicit provider > tag routing > defaults.
 * When routing supplies a provider it also supplies (or clears) the model; the
 * default model is kept only when the resolved provider is the default one.
 */
export async function resolveTaskEngine(
  input: ResolveEngineInput,
  deps: EngineRoutingDeps,
): Promise<{ provider: string; model: string | null }> {
  const explicit = input.explicitProvider?.trim();
  if (explicit) {
    // An explicit provider wins; keep the default model only if it matches.
    return { provider: explicit, model: explicit === input.defaultProvider ? input.defaultModel : null };
  }

  const route = await resolveRoute(input.tag, input.authorProvider, deps);
  if (route?.provider) {
    return { provider: route.provider, model: route.model ?? null };
  }

  return { provider: input.defaultProvider, model: input.defaultModel };
}
