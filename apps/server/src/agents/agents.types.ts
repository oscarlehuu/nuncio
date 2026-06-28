import type { ModelOptionsMap } from '../models/model-options.types';
import type { ModelProviderDto } from '../models/models.types';

export type EventEmitter = (event: { type: string; payload: unknown }) => void;

export interface AgentRunContext {
  emit?: EventEmitter;
  model?: string | null;
  modelOptions?: ModelOptionsMap | null;
  workspace?: string | null;
  cwd?: string;
  /** CLI handoff: Cursor chat UUID for `agent --resume`. */
  cursorChatId?: string | null;
  /** Transcript mtime (ms) for active-run guard. */
  transcriptMtimeMs?: number | null;
  /** CLI checkpoint store mtime (ms) for active-run guard. */
  chatStoreMtimeMs?: number | null;
  /** Skip active-run guard when user explicitly forces resume. */
  forceResume?: boolean;
}

export interface AgentProvider {
  readonly id: string;
  readonly name: string;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<ModelProviderDto[]>;
  run(sessionId: string, prompt: string, context: AgentRunContext): Promise<void>;
  steer(sessionId: string, message: string, context: AgentRunContext): Promise<void>;
  dispose(sessionId: string): void;
  /** Clear any cached availability/model state so the next call re-resolves from current settings. */
  bustCache(): void;
}
