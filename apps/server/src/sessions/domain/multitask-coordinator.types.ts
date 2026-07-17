import type { SessionEventType } from './events.types';
import type { SessionDto } from './sessions.types';

/**
 * Hooks the session layer hands the coordinator so it can annotate the parent
 * transcript and observe detachment WITHOUT reaching back into SessionsService's
 * internals. Keeps the module edge one-directional: SessionsService holds a
 * registered coordinator; the coordinator (in TasksModule) never imports it.
 */
export interface MultitaskCoordinationHooks {
  /** Append an orchestration event to the parent transcript (never throws). */
  emitParentEvent(type: SessionEventType, payload: unknown): void;
  /** True once the parent has left RUNNING (paused / archived / interrupted / errored). */
  parentDetached(): boolean;
}

/**
 * Owns a multitask parent's coordinating turn: decompose the goal, announce the
 * split, fan children out through the task machinery, and resolve only once
 * every spawned child has settled OR the parent detaches. Throwing signals a
 * coordination failure — the session layer lands the parent in ERROR.
 */
export interface MultitaskCoordinator {
  coordinate(session: SessionDto, hooks: MultitaskCoordinationHooks): Promise<void>;
}
