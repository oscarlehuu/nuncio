import { Inject, Injectable, Optional } from '@nestjs/common';
import { AgentRegistry } from '../../agents/agents.registry';
import { ContextFactsService } from '../../context/context-facts.service';
import type { AgentRuntimeTools } from '../../agents/tools/agent-runtime-tools.types';
import type { SessionDto } from '../../sessions/domain/sessions.types';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { resolveVerifyCommand } from '../../sessions/session-verifier';
import { SettingsService } from '../../settings/settings.service';
import { TasksRepository } from '../../tasks/tasks.repository';
import { TASK_ENQUEUER, type TaskEnqueuer } from './task-enqueuer.token';
import { resolveTaskEngine } from '../engine-routing';
import { buildWorkspaceSnapshot } from '../workspace-snapshot';
import { buildOrchestrationTools } from './orchestration-tools.factory';
import type {
  OrchestrationMode,
  OrchestrationScope,
  OrchestrationToolDeps,
} from './orchestration-tools.types';

const MODES: readonly OrchestrationMode[] = ['off', 'read', 'read-write'];

/**
 * Wires the pure orchestration-tools factory to concrete repositories/services
 * and gates it on NUNCIO_ORCHESTRATION_TOOLS. Uses only repositories plus a
 * forward-ref'd TasksService (for enqueue+pump), so there is no import cycle
 * back through the tool registry.
 */
@Injectable()
export class OrchestrationToolsService {
  constructor(
    private readonly sessionsRepo: SessionsRepository,
    private readonly events: EventsRepository,
    private readonly tasksRepo: TasksRepository,
    @Optional() @Inject(TASK_ENQUEUER) private readonly enqueuer?: TaskEnqueuer,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly agents?: AgentRegistry,
    @Optional() private readonly contextFacts?: ContextFactsService,
  ) {}

  private mode(): OrchestrationMode {
    const raw = this.settings?.resolve('NUNCIO_ORCHESTRATION_TOOLS');
    return MODES.includes(raw as OrchestrationMode) ? (raw as OrchestrationMode) : 'off';
  }

  /** Build the orchestration tools for a scope; empty when the setting is off. */
  forScope(scope: OrchestrationScope): AgentRuntimeTools {
    return buildOrchestrationTools(this.buildDeps(), scope, this.mode());
  }

  private buildDeps(): OrchestrationToolDeps {
    return {
      currentMode: () => this.mode(),
      listSessions: () => this.sessionsRepo.list(),
      findSession: (id) => this.sessionsRepo.findById(id),
      childrenOf: (parentSessionId) => this.sessionsRepo.childrenOf(parentSessionId),
      listEventsSince: (sessionId, since, limit) => this.events.listSince(sessionId, since, limit),
      listTasks: (parentSessionId) =>
        parentSessionId ? this.tasksRepo.listByParentSession(parentSessionId) : this.tasksRepo.list(),
      findTask: (id) => this.tasksRepo.findById(id),
      enqueueTask: (input) => {
        if (!this.enqueuer) throw new Error('task runner unavailable');
        return this.enqueuer.enqueue(input);
      },
      queuePosition: (taskId) => {
        const queued = this.tasksRepo
          .list()
          .filter((t) => t.status === 'QUEUED')
          .sort((a, b) => a.createdAt - b.createdAt);
        const index = queued.findIndex((t) => t.id === taskId);
        return index >= 0 ? index + 1 : queued.length + 1;
      },
      resolveEngine: (parent, explicitProvider, tag) => {
        const defaultProvider =
          this.settings?.resolve('NUNCIO_SUBAGENT_PROVIDER')?.trim() || parent.provider;
        const defaultModel = this.settings?.resolve('NUNCIO_SUBAGENT_MODEL')?.trim() || parent.model || null;
        return resolveTaskEngine(
          {
            explicitProvider,
            tag,
            authorProvider: parent.provider,
            defaultProvider,
            defaultModel,
          },
          this.routingDeps(),
        );
      },
      buildWorkspaceSnapshot: async (parent) => {
        const cwd = parent.worktreePath ?? parent.workspace ?? parent.projectPath ?? null;
        if (!cwd) return null;
        return buildWorkspaceSnapshot(cwd, parent.baseBranch ?? parent.branch);
      },
      resolveVerifyCommand: (parent: SessionDto) => {
        const cwd = parent.worktreePath ?? parent.workspace ?? parent.projectPath ?? null;
        if (!cwd) return null;
        return resolveVerifyCommand(cwd, this.settings?.resolve('NUNCIO_VERIFY_COMMAND'))?.display ?? null;
      },
      listProjectFacts: (projectPath) => (this.contextFacts ? this.contextFacts.list(projectPath) : []),
      recordProjectFact: (input) => {
        if (!this.contextFacts) return { status: 'error', message: 'context facts store unavailable' };
        try {
          const outcome = this.contextFacts.upsert({
            projectPath: input.projectPath,
            key: input.key,
            value: input.value,
            provenance: 'agent',
            sourceSessionId: input.sourceSessionId,
          });
          return outcome.written
            ? { status: 'written', message: `Recorded project fact "${input.key}".` }
            : {
                status: 'proposed',
                message: `A founder fact "${input.key}" already exists; your change was submitted as a proposal pending founder review.`,
              };
        } catch (error) {
          return { status: 'error', message: error instanceof Error ? error.message : 'invalid fact' };
        }
      },
    };
  }

  /** Engine-routing deps (settings JSON + live provider availability). */
  private routingDeps() {
    return {
      routingJson: this.settings?.resolve('NUNCIO_ENGINE_ROUTING'),
      availableProviderIds: async () =>
        this.agents ? (await this.agents.available()).map((p) => p.id) : [],
    };
  }
}
