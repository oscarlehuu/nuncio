import { BadRequestException, Injectable, NotFoundException, Optional, type OnModuleInit } from '@nestjs/common';
import { AttentionRepository } from '../attention/attention.repository';
import { AttentionService } from '../attention/attention.service';
import type { AttentionItemDto } from '../attention/attention.types';
import { EventsRepository } from '../sessions/persistence/events.repository';
import { SessionsRepository } from '../sessions/persistence/sessions.repository';
import { LoopsService } from '../loops/loops.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { ProjectDefaultsResolver } from '../projects/project-defaults-resolver';
import { isValidScheduleSpec } from '../scheduler/schedule-spec';
import { SchedulerService } from '../scheduler/scheduler.service';
import type { Clock } from '../scheduler/scheduler.types';
import { SettingsService } from '../settings/settings.service';
import { TasksService } from '../tasks/tasks.service';
import type { CreateTaskDto } from '../tasks/tasks.types';
import {
  DISPATCHER_KIND,
  DISPATCHER_SEVERITY,
  dispatcherSubjectFor,
  foldDispatcherProposals,
  type DispatcherProposal,
  type DispatcherRuleSources,
} from './dispatcher-rules';

const DISPATCHER_JOB = 'dispatcher-evening';
const DISPATCHER_SPEC_KEY = 'NUNCIO_DISPATCHER_EVENING_SPEC';
const DEFAULT_DISPATCHER_SPEC = 'daily@20:05';

interface DispatcherPayload {
  proposals: DispatcherProposal[];
  draftedAt?: number;
  approvedAt?: number;
  taskIds?: string[];
}

@Injectable()
export class DispatcherService implements OnModuleInit {
  clock: Clock = { now: () => Date.now() };

  constructor(
    private readonly attention: AttentionService,
    private readonly items: AttentionRepository,
    private readonly tasks: TasksService,
    @Optional() private readonly scheduler?: SchedulerService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly sessions?: SessionsRepository,
    @Optional() private readonly events?: EventsRepository,
    @Optional() private readonly loops?: LoopsService,
    @Optional() private readonly projects?: ProjectsRepository,
    @Optional() private readonly projectDefaults?: ProjectDefaultsResolver,
  ) {}

  onModuleInit(): void {
    this.scheduler?.addSystemFireHandler((job) => {
      if (job === DISPATCHER_JOB) return this.draftNow();
      return undefined;
    });
    this.ensureSchedule();
  }

  async draftNow(): Promise<AttentionItemDto | null> {
    return this.draftFromSources(this.collectSources());
  }

  draftFromSources(sources: DispatcherRuleSources): AttentionItemDto | null {
    const proposals = foldDispatcherProposals({ ...sources, now: sources.now ?? this.clock.now() });
    if (proposals.length === 0) return null;
    const now = this.clock.now();
    const day = dispatcherSubjectFor(now).replace('dispatch:', '');
    return this.attention.raise({
      kind: DISPATCHER_KIND,
      subjectId: dispatcherSubjectFor(now),
      projectPath: null,
      title: `Dispatcher proposal for ${day}`,
      payload: { proposals, draftedAt: now },
    });
  }

  approve(id: string): { proposalId: string; taskIds: string[] } {
    const item = this.items.findById(id);
    if (!item) throw new NotFoundException(`Dispatcher proposal ${id} not found`);
    if (item.kind !== DISPATCHER_KIND) throw new BadRequestException('attention item is not a dispatcher proposal');

    const payload = parsePayload(item.payload);
    if (payload.taskIds?.length) {
      if (item.status !== 'resolved') this.attention.resolve(id);
      return { proposalId: id, taskIds: payload.taskIds };
    }
    if (!payload.proposals.length) throw new BadRequestException('dispatcher proposal has no tasks');

    const existingTasks = this.tasks.list();
    const firstCorrelationByTask = new Map<string, string>();
    const entries = payload.proposals.map((proposal, index) => {
      const correlationKey = approvalCorrelationKey(id, index);
      const existing = existingTasks.find((task) =>
        isActiveTask(task) &&
        task.prompt === proposal.prompt &&
        task.projectPath === proposal.projectPath
      );
      const identity = approvalTaskIdentity(proposal);
      const reuseCorrelationKey = existing
        ? undefined
        : firstCorrelationByTask.get(identity);
      if (!existing && !reuseCorrelationKey) firstCorrelationByTask.set(identity, correlationKey);
      return {
        input: taskInputFromProposal(proposal),
        correlationKey,
        ...(existing ? { existingTaskId: existing.id } : {}),
        ...(reuseCorrelationKey ? { reuseCorrelationKey } : {}),
      };
    });

    const committed = this.tasks.enqueueApprovalBatch(entries, (approvedTasks) => {
      const taskIds = approvedTasks.map((task) => task.id);
      const approvedAt = this.clock.now();
      const updated = this.items.updatePayload(id, { ...payload, approvedAt, taskIds }, approvedAt);
      if (!updated) throw new NotFoundException(`Dispatcher proposal ${id} not found`);
      this.attention.resolve(id);
      return taskIds;
    });
    return { proposalId: id, taskIds: committed.correlated };
  }

  ensureSchedule(): void {
    if (!this.scheduler) return;
    const configured = this.settings?.resolve(DISPATCHER_SPEC_KEY);
    const spec = configured === undefined ? DEFAULT_DISPATCHER_SPEC : configured.trim();
    const kind: 'cron' | 'heartbeat' = spec.startsWith('daily@') ? 'cron' : 'heartbeat';
    const valid = isValidScheduleSpec(spec);
    const existing = this.scheduler
      .listSchedules()
      .find((schedule) => schedule.target.kind === 'system' && schedule.target.job === DISPATCHER_JOB);
    if (!existing) {
      this.scheduler.create({
        kind,
        spec,
        enabled: valid,
        target: { kind: 'system', job: DISPATCHER_JOB },
      });
      return;
    }
    if (!valid) {
      if (existing.enabled) this.scheduler.setEnabled(existing.id, false);
      if (existing.spec !== spec) this.scheduler.updateSpec(existing.id, kind, spec);
      return;
    }
    if (existing.spec !== spec) this.scheduler.updateSpec(existing.id, kind, spec);
    if (!existing.enabled) this.scheduler.setEnabled(existing.id, true);
  }

  private collectSources(): DispatcherRuleSources {
    const sessions = this.sessions?.listUserFacing(true) ?? [];
    const projects = this.projects?.list() ?? [];
    const loops = this.loops?.list() ?? [];
    return {
      attentionItems: this.items.list('open'),
      loops,
      loopRuns: loops.flatMap((loop) => this.loops?.runs(loop.id) ?? []),
      sessions,
      eventsBySession: Object.fromEntries(sessions.map((session) => [session.id, this.events?.list(session.id) ?? []])),
      tasks: this.tasks.list(),
      projectDefaults: Object.fromEntries(
        projects.map((project) => [
          project.path,
          {
            engine: this.projectDefaults?.resolveDefaultEngine(project.path) ?? project.defaultEngine,
            model: null,
          },
        ]),
      ),
      projectWeights: Object.fromEntries(projects.map((project) => [project.path, project.weight])),
      now: this.clock.now(),
    };
  }
}

function parsePayload(payload: Record<string, unknown> | null): DispatcherPayload {
  const proposals = payload?.proposals;
  const taskIds = payload?.taskIds;
  return {
    proposals: Array.isArray(proposals) ? proposals.filter(isProposal) : [],
    ...(typeof payload?.draftedAt === 'number' ? { draftedAt: payload.draftedAt } : {}),
    ...(typeof payload?.approvedAt === 'number' ? { approvedAt: payload.approvedAt } : {}),
    ...(Array.isArray(taskIds) && taskIds.every((id) => typeof id === 'string') ? { taskIds } : {}),
  };
}

function isProposal(value: unknown): value is DispatcherProposal {
  if (!value || typeof value !== 'object') return false;
  const proposal = value as Partial<DispatcherProposal>;
  return (
    typeof proposal.subjectKey === 'string' &&
    typeof proposal.title === 'string' &&
    typeof proposal.prompt === 'string' &&
    typeof proposal.rationale === 'string' &&
    (proposal.projectPath === null || typeof proposal.projectPath === 'string')
  );
}

function taskInputFromProposal(proposal: DispatcherProposal): CreateTaskDto {
  return {
    prompt: proposal.prompt,
    ...(proposal.engine ? { provider: proposal.engine } : {}),
    ...(proposal.model ? { model: proposal.model } : {}),
    ...(proposal.projectPath ? { projectPath: proposal.projectPath } : {}),
  };
}

function approvalCorrelationKey(proposalId: string, index: number): string {
  return `dispatcher:${proposalId}:${index}`;
}

function approvalTaskIdentity(proposal: DispatcherProposal): string {
  return JSON.stringify([proposal.prompt, proposal.projectPath]);
}

function isActiveTask(task: { status: string }): boolean {
  return task.status === 'QUEUED' || task.status === 'RUNNING';
}

export { DEFAULT_DISPATCHER_SPEC, DISPATCHER_JOB, DISPATCHER_SPEC_KEY };
