import type { ModelProviderDto } from '../models/models.types';

export type EventEmitter = (event: { type: string; payload: unknown }) => void;

export interface AgentRunContext {
  emit?: EventEmitter;
  model?: string | null;
  workspace?: string | null;
  cwd?: string;
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
