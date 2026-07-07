import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import type {
  LoopDto,
  LoopRunDto,
  LoopRunOutcome,
  LoopStatus,
} from './loops.types';

/**
 * Durable loops + loop_runs (ADR-006). SKELETON — the red suite drives the
 * contract; methods throw until implemented.
 */
@Injectable()
export class LoopsRepository {
  constructor(private readonly database: DatabaseService) {
    void this.database;
  }

  create(_input: {
    goal: string;
    scheduleId: string;
    maxRunsPerDay: number;
    maxConsecutiveFailures: number;
    stopJson: string | null;
    escalation: string;
    projectPath: string | null;
  }): LoopDto {
    throw new Error('LoopsRepository.create not implemented');
  }

  findById(_id: string): LoopDto | null {
    throw new Error('LoopsRepository.findById not implemented');
  }

  list(): LoopDto[] {
    throw new Error('LoopsRepository.list not implemented');
  }

  setStatus(_id: string, _status: LoopStatus): LoopDto {
    throw new Error('LoopsRepository.setStatus not implemented');
  }

  delete(_id: string): void {
    throw new Error('LoopsRepository.delete not implemented');
  }

  appendRun(_input: {
    loopId: string;
    taskId: string | null;
    outcome: LoopRunOutcome;
    dayBucket: string;
  }): LoopRunDto {
    throw new Error('LoopsRepository.appendRun not implemented');
  }

  listRuns(_loopId: string): LoopRunDto[] {
    throw new Error('LoopsRepository.listRuns not implemented');
  }
}
