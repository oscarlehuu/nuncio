import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import type { CreateScheduleDto, FireResult, ScheduleDto } from './scheduler.types';

/**
 * Durable schedule state (ADR-006). SKELETON — the red suite drives the contract;
 * methods throw until implemented so tests fail for missing-feature.
 */
@Injectable()
export class SchedulesRepository {
  constructor(private readonly database: DatabaseService) {
    void this.database;
  }

  create(_input: CreateScheduleDto & { nextFireAt: number | null }): ScheduleDto {
    throw new Error('SchedulesRepository.create not implemented');
  }

  findById(_id: string): ScheduleDto | null {
    throw new Error('SchedulesRepository.findById not implemented');
  }

  list(): ScheduleDto[] {
    throw new Error('SchedulesRepository.list not implemented');
  }

  /** Enabled cron/heartbeat schedules with next_fire_at <= now. */
  listDue(_now: number): ScheduleDto[] {
    throw new Error('SchedulesRepository.listDue not implemented');
  }

  setEnabled(_id: string, _enabled: boolean, _nextFireAt: number | null): ScheduleDto {
    throw new Error('SchedulesRepository.setEnabled not implemented');
  }

  recordFire(_id: string, _at: number, _result: FireResult, _nextFireAt: number | null): void {
    throw new Error('SchedulesRepository.recordFire not implemented');
  }

  setNextFire(_id: string, _nextFireAt: number | null): void {
    throw new Error('SchedulesRepository.setNextFire not implemented');
  }

  delete(_id: string): void {
    throw new Error('SchedulesRepository.delete not implemented');
  }
}
