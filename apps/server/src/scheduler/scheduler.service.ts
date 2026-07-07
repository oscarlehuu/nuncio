import { Injectable, Optional } from '@nestjs/common';
import { TasksService } from '../tasks/tasks.service';
import { SchedulesRepository } from './schedules.repository';
import type { Clock, CreateScheduleDto, ScheduleDto } from './scheduler.types';
import type { ForgeWebhookEvent } from '../forges/forges.types';

/**
 * Daemon-resident firing loop: scans due cron/heartbeat schedules and matches
 * event schedules against inbound webhooks, firing targets through TasksService.
 * SKELETON — the red suite drives the contract; methods throw until implemented.
 * All time flows through the injectable `clock` (deterministic in tests).
 */
@Injectable()
export class SchedulerService {
  /** Injectable clock seam — overridden in tests for deterministic time. */
  clock: Clock = { now: () => Date.now() };

  constructor(
    private readonly schedules: SchedulesRepository,
    @Optional() private readonly tasks?: TasksService,
  ) {
    void this.schedules;
    void this.tasks;
  }

  /** Create a schedule; computes next_fire_at from spec + clock for cron/heartbeat. */
  create(_input: CreateScheduleDto): ScheduleDto {
    throw new Error('SchedulerService.create not implemented');
  }

  /** Boot rehydration: recompute next_fire_at from spec + clock; apply missed policy. */
  rehydrate(): void {
    throw new Error('SchedulerService.rehydrate not implemented');
  }

  /** Fire every due schedule once (the single-timer scan; called directly in tests). */
  scanDue(): void {
    throw new Error('SchedulerService.scanDue not implemented');
  }

  /** Match an inbound (already de-duplicated) webhook event against event schedules and fire. */
  handleWebhookEvent(_provider: string, _event: ForgeWebhookEvent): void {
    throw new Error('SchedulerService.handleWebhookEvent not implemented');
  }

  setEnabled(_id: string, _enabled: boolean): ScheduleDto {
    throw new Error('SchedulerService.setEnabled not implemented');
  }
}
