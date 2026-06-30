import type { ModelOptionsMap } from '../models/model-options.types';
import type { ModelProviderDto } from '../models/models.types';
import type {
  ProviderRequestInput,
  ProviderRequestResult,
} from '../sessions/domain/sessions.types';
import type { UserInputAnswer } from '../sessions/domain/user-input.types';

export type EventEmitter = (event: { type: string; payload: unknown }) => void;

export interface InteractionResponse {
  answers: UserInputAnswer[];
  resolvedBy: 'user' | 'skip';
}

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
  /** Whether the last JSONL entry is `turn_ended` — agent is idle. */
  transcriptTurnEnded?: boolean;
  /** Skip active-run guard when user explicitly forces resume. */
  forceResume?: boolean;
  /** Provider-agnostic approval hook for SDK/tool requests that need a user decision. */
  requestProviderApproval?: (request: ProviderRequestInput) => Promise<ProviderRequestResult>;
}

export interface AgentProvider {
  readonly id: string;
  readonly name: string;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<ModelProviderDto[]>;
  run(sessionId: string, prompt: string, context: AgentRunContext): Promise<void>;
  steer(sessionId: string, message: string, context: AgentRunContext): Promise<void>;
  dispose(sessionId: string): void;
  /** Whether this provider can respond to live interactive tool prompts (e.g. AskQuestion). */
  supportsInteraction?(): boolean;
  /** Submit answers for a pending interactive tool prompt. Live path only — historical imports skip this. */
  submitInteraction?(
    sessionId: string,
    requestId: string,
    response: InteractionResponse,
    context: AgentRunContext,
  ): Promise<void>;
  /** Clear any cached availability/model state so the next call re-resolves from current settings. */
  bustCache(): void;
}
