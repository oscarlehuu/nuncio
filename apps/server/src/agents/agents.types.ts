import type { ModelOptionsMap } from '../models/model-options.types';
import type { ModelProviderDto } from '../models/models.types';
import type {
  ProviderRequestInput,
  ProviderRequestResult,
  SessionDto,
} from '../sessions/domain/sessions.types';
import type { UserInputAnswer } from '../sessions/domain/user-input.types';
import type { AgentRuntimeTools } from './tools/agent-runtime-tools.types';

/**
 * Providers emit the event exactly as it was appended to the log: when `seq`
 * is present the consumer can fan it out without re-reading the event table.
 */
export type EventEmitter = (event: {
  type: string;
  payload: unknown;
  seq?: number;
  createdAt?: number;
}) => void;

export interface AgentCapabilities {
  interrupt: boolean;
  modelSwitch: 'in-session' | 'restart' | 'none';
  effortSwitch: 'in-session' | 'restart' | 'none';
  images: boolean;
  /** Whether the provider can inject a steer message into a run that is already streaming. */
  steerWhileRunning: boolean;
}

export interface AgentAttachment {
  kind: 'image';
  mimeType: string;
  /** Base64 bytes — sent to the model, and used to persist to the media store. */
  data: string;
  /** Media-store id once persisted; the transcript event references this so the
   * event log holds a pointer, not base64. Absent on inbound (pre-persist) ones. */
  id?: string;
}

export interface InteractionResponse {
  answers: UserInputAnswer[];
  resolvedBy: 'user' | 'skip';
}

export interface AgentRunContext {
  emit?: EventEmitter;
  model?: string | null;
  modelOptions?: ModelOptionsMap | null;
  attachments?: AgentAttachment[];
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
  /**
   * Extra fields stamped onto the emitted steer_message payload. Used by the
   * verify-feedback loop to tag an auto-steer (`{ origin: 'verify_retry',
   * retryId }`) so consumers classify it explicitly rather than by adjacency.
   * A human steer leaves this undefined.
   */
  steerMeta?: Record<string, unknown>;
  /** Provenance stamped onto the emitted steer_message (e.g. 'task-digest'). */
  steerOrigin?: string;
  /** Provider-agnostic approval hook for SDK/tool requests that need a user decision. */
  requestProviderApproval?: (request: ProviderRequestInput) => Promise<ProviderRequestResult>;
  /** Session-bound runtime tools that providers adapt into SDK-native tool contracts. */
  tools?: AgentRuntimeTools;
}

export interface AgentProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: AgentCapabilities;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<ModelProviderDto[]>;
  run(sessionId: string, prompt: string, context: AgentRunContext): Promise<void>;
  steer(sessionId: string, message: string, context: AgentRunContext): Promise<void>;
  /**
   * Queue a steer message into a live streaming run. Returns false when there is
   * no active in-process run to steer (caller falls back to queueing).
   */
  steerMidRun?(sessionId: string, message: string, context: AgentRunContext): Promise<boolean>;
  interrupt?(sessionId: string): Promise<void>;
  setModel?(sessionId: string, model: string, options?: ModelOptionsMap | null): Promise<void>;
  dispose(sessionId: string): void;
  /** Fence callbacks from the current provider run without changing the FSM. */
  invalidateRun?(sessionId: string): void;
  /**
   * Synchronously flush any coalesced/buffered events for the session so they
   * reach the log before an externally-appended event is written at a later seq.
   * No-op when nothing is buffered.
   */
  flushPendingEvents?(sessionId: string): void;
  /** Session ids whose accepted events are still waiting for persistence. */
  pendingEventSessionIds?(): string[];
  /** Stop retry timers once shutdown can no longer persist their retained tails. */
  cancelPendingEventRetries?(sessionId?: string): void;
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
  /**
   * Whether a session's provider thread can be continued after the daemon
   * process is replaced (durable thread handle exists outside daemon memory).
   */
  canResumeThread?(session: SessionDto): boolean;
}
