import { Injectable, Optional } from '@nestjs/common';
import { SchedulerService } from '../scheduler/scheduler.service';
import { LoopsRepository } from './loops.repository';
import type { Clock } from '../scheduler/scheduler.types';
import type { CreateLoopDto, LoopDto, LoopRunDto } from './loops.types';

/**
 * The loop primitive (rung 2 sub-phase C): standing tasks that fire loop-runs
 * through the scheduler inside run-count budgets + a consecutive-failure breaker,
 * output landing via worktree + PR. All counting derives from durable loop_runs
 * rows. SKELETON — the red suite drives the contract; methods throw until built.
 */
@Injectable()
export class LoopsService {
  /** Injectable clock seam — deterministic in tests. */
  clock: Clock = { now: () => Date.now() };

  constructor(
    private readonly loops: LoopsRepository,
    @Optional() private readonly scheduler?: SchedulerService,
  ) {
    void this.loops;
    void this.scheduler;
  }

  /** Create a loop + its owned schedule (one call). */
  create(_input: CreateLoopDto): LoopDto {
    throw new Error('LoopsService.create not implemented');
  }

  list(): LoopDto[] {
    throw new Error('LoopsService.list not implemented');
  }

  findById(_id: string): LoopDto | null {
    throw new Error('LoopsService.findById not implemented');
  }

  /** A scheduler fire resolves loopId → runs the loop (budget-checked), returns the run. */
  fire(_loopId: string): LoopRunDto | null {
    throw new Error('LoopsService.fire not implemented');
  }

  /** Feed a settled task's outcome back into budget/breaker accounting. */
  recordTaskOutcome(_loopId: string, _taskId: string, _ok: boolean): void {
    throw new Error('LoopsService.recordTaskOutcome not implemented');
  }

  pause(_id: string): LoopDto {
    throw new Error('LoopsService.pause not implemented');
  }

  resume(_id: string): LoopDto {
    throw new Error('LoopsService.resume not implemented');
  }

  delete(_id: string): void {
    throw new Error('LoopsService.delete not implemented');
  }

  runs(_id: string): LoopRunDto[] {
    throw new Error('LoopsService.runs not implemented');
  }
}
