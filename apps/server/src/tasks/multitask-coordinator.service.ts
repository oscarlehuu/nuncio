import { Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { AgentRegistry } from '../agents/agents.registry';
import {
  clampSubtaskCap,
  normalizeDecomposition,
  type MultitaskDecomposition,
} from '../sessions/domain/multitask-decompose';
import type {
  MultitaskCoordinationHooks,
  MultitaskCoordinator,
} from '../sessions/domain/multitask-coordinator.types';
import type { SessionDto } from '../sessions/domain/sessions.types';
import { SessionsService } from '../sessions/sessions.service';
import { SettingsService } from '../settings/settings.service';
import { allChildrenSettled, projectMultitaskBoard } from './multitask-board';
import { TasksService } from './tasks.service';
import type { TaskDto } from './tasks.types';

/** How often to re-check for detachment while children run (settlement is event-driven). */
const DETACH_POLL_MS = 1000;

/**
 * Runs a multitask-mode parent's coordinating turn. Registered into the session
 * layer at construction (the session layer holds the interface, never imports
 * this) so create() can divert a `decompose`-capable multitask parent here
 * instead of a normal agent turn.
 *
 * Lifecycle: decompose the goal → announce the split on the parent transcript →
 * fan one child out per subtask through the EXISTING task machinery (own
 * worktree, inherited model) → stay pending until every child settles or the
 * parent detaches. The session layer holds the parent in RUNNING for the whole
 * of this and lands it IDLE (or ERROR on a throw) when we resolve.
 */
@Injectable()
export class MultitaskCoordinatorService implements MultitaskCoordinator, OnModuleDestroy {
  /** Pending settlement waits, finished on shutdown so no timer/subscription leaks. */
  private readonly pendingWaits = new Set<() => void>();

  constructor(
    private readonly tasks: TasksService,
    private readonly sessions: SessionsService,
    private readonly agents: AgentRegistry,
    @Optional() private readonly settings?: SettingsService,
  ) {
    this.sessions.registerMultitaskCoordinator(this);
  }

  onModuleDestroy(): void {
    for (const finish of [...this.pendingWaits]) finish();
  }

  async coordinate(session: SessionDto, hooks: MultitaskCoordinationHooks): Promise<void> {
    const provider = await this.agents.resolveAvailableForSession(session);
    if (!provider.decompose) {
      // create() only diverts here when decompose exists; guard the contract anyway.
      throw new Error(`Engine ${provider.id} cannot decompose multitask goals`);
    }

    const cap = clampSubtaskCap(this.settings?.resolve('NUNCIO_MULTITASK_MAX_SUBTASKS'));
    const cwd = session.worktreePath ?? session.workspace ?? session.projectPath ?? null;
    const raw = await provider.decompose({
      goal: session.prompt,
      maxSubtasks: cap,
      model: session.model,
      cwd,
    });
    const decomposition = normalizeDecomposition(raw, cap);

    // The coordinator "speaks" the split as an assistant message so it renders
    // as a visible bubble in the parent transcript (a status note would not).
    hooks.emitParentEvent('assistant_message', { text: announceSplit(decomposition) });

    const { tasks } = await this.tasks.startMultitask({
      parentSessionId: session.id,
      prompts: decomposition.subtasks.map((subtask) => subtask.prompt),
    });
    const childTaskIds = tasks.map((task) => task.id);
    if (childTaskIds.length === 0) return; // floor of 2 makes this unreachable; stay safe

    await this.awaitChildrenSettled(childTaskIds, hooks);

    // Suppress the closing summary if the parent detached mid-flight — it left
    // RUNNING on purpose, so don't append a "settled" bubble to a paused board.
    if (!hooks.parentDetached()) {
      hooks.emitParentEvent('assistant_message', { text: this.announceSettled(childTaskIds) });
    }
  }

  /**
   * Resolve once every spawned child reaches a terminal state OR the parent
   * detaches. Settlement is event-driven (the task finish hook); a bounded poll
   * covers detachment and any child that settled before we subscribed.
   */
  private awaitChildrenSettled(
    childTaskIds: string[],
    hooks: MultitaskCoordinationHooks,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.pendingWaits.delete(finish);
        unsubscribe();
        clearInterval(timer);
        resolve();
      };
      const check = (): void => {
        if (hooks.parentDetached() || allChildrenSettled(this.childRows(childTaskIds))) finish();
      };
      const unsubscribe = this.tasks.onTaskFinished((task) => {
        if (childTaskIds.includes(task.id)) check();
      });
      const timer = setInterval(check, DETACH_POLL_MS);
      this.pendingWaits.add(finish);
      check(); // fast engines can settle every child before the listener attaches
    });
  }

  /** Current rows for the spawned children; a vanished (deleted) child drops out. */
  private childRows(childTaskIds: string[]): TaskDto[] {
    return childTaskIds
      .map((id) => this.tasks.findById(id))
      .filter((task): task is TaskDto => task !== null);
  }

  private announceSettled(childTaskIds: string[]): string {
    const board = projectMultitaskBoard(this.childRows(childTaskIds));
    const parts = [`${board.done} done`];
    if (board.failed) parts.push(`${board.failed} failed`);
    if (board.cancelled) parts.push(`${board.cancelled} cancelled`);
    return `All ${childTaskIds.length} subagents settled (${parts.join(', ')}).`;
  }
}

function announceSplit(decomposition: MultitaskDecomposition): string {
  const scopes = decomposition.subtasks.map((subtask, index) => `${index + 1}. ${subtask.scope}`);
  const lines = [`Split into ${decomposition.subtasks.length} independent subtasks:`, ...scopes];
  if (decomposition.nonOverlap) lines.push(`Non-overlap: ${decomposition.nonOverlap}`);
  return lines.join('\n');
}
