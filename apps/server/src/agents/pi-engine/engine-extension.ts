import { evaluateGateIntegrity } from './gate-integrity';
import type {
  CompactionHandlerResult,
  SessionBeforeCompactEventLike,
} from './compaction-extension';

/**
 * The in-repo Nuncio Engine inline extension — the rail every Engine hook
 * rides. It is passed to the resource loader through `extensionFactories`, so
 * it loads even under `noExtensions: true` (allowlist mode) AND under full
 * discovery. Each capability registers through this one factory but stays
 * independently toggleable, per docs/pi-engine.md principle 3.
 */

export const NUNCIO_ENGINE_EXTENSION_NAME = 'nuncio-engine';

export interface NuncioEngineExtensionOptions {
  /** Session working directory the gate paths resolve against. */
  cwd: string;
  /** Register the gate-integrity tool_call guard. */
  gateGuard: boolean;
  /** Register the compaction policy hook (session_before_compact). */
  compaction?: {
    handler(event: SessionBeforeCompactEventLike): Promise<CompactionHandlerResult | undefined>;
  };
}

/** Structural subset of Pi's ExtensionAPI that the engine extension uses. */
interface EngineExtensionApi {
  on(event: 'tool_call', handler: (event: ToolCallEventLike) => ToolCallResultLike): void;
  on(
    event: 'session_before_compact',
    handler: (event: SessionBeforeCompactEventLike) => Promise<CompactionHandlerResult | undefined>,
  ): void;
}

interface ToolCallEventLike {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  input: unknown;
}

type ToolCallResultLike = { block?: boolean; reason?: string } | undefined;

/**
 * Build the inline extension object (`{ name, factory }` form so the loader's
 * startup extension list shows `<inline:nuncio-engine>`).
 */
export function buildNuncioEngineExtension(options: NuncioEngineExtensionOptions): unknown {
  const factory = (pi: EngineExtensionApi): void => {
    if (options.gateGuard) {
      pi.on('tool_call', (event) => evaluateGateIntegrity(options.cwd, event));
    }
    if (options.compaction) {
      const { handler } = options.compaction;
      pi.on('session_before_compact', (event) => handler(event));
    }
  };
  return { name: NUNCIO_ENGINE_EXTENSION_NAME, factory };
}
