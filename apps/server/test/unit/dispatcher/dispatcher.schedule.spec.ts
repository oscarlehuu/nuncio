import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import {
  DEFAULT_DISPATCHER_SPEC,
  DISPATCHER_JOB,
  DISPATCHER_SPEC_KEY,
  DispatcherService,
} from '../../../src/dispatcher/dispatcher.service';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';
import { SettingsService } from '../../../src/settings/settings.service';
import { SettingsRepository } from '../../../src/settings/persistence/settings.repository';

const INVALID_PERSISTED_SPECS = [
  '',
  'every:0m',
  'every:-5m',
  'not-a-cadence',
  '每天@20:05',
  'x'.repeat(10_000),
];

describe('DispatcherService schedule configuration', () => {
  let dataDir = '';
  let database: DatabaseService;
  let schedules: SchedulesRepository;
  let scheduler: SchedulerService;
  let settings: SettingsService;
  let dispatcher: DispatcherService;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-dispatcher-schedule-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    database = new DatabaseService();
    schedules = new SchedulesRepository(database);
    scheduler = new SchedulerService(schedules);
    settings = new SettingsService(new SettingsRepository(database), Buffer.alloc(32));
    dispatcher = new DispatcherService(
      {} as never,
      {} as never,
      {} as never,
      scheduler,
      settings,
    );
  });

  afterEach(() => {
    scheduler.onModuleDestroy();
    database.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env[DISPATCHER_SPEC_KEY];
  });

  it.each(INVALID_PERSISTED_SPECS)(
    'keeps an invalid persisted cadence disabled without aborting startup: %p',
    (invalid) => {
      settings.set(DISPATCHER_SPEC_KEY, invalid);

      expect(() => dispatcher.onModuleInit()).not.toThrow();

      const rows = dispatcherSchedules(schedules);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ spec: invalid.trim(), enabled: false });
    },
  );

  it('keeps an invalid env cadence disabled without aborting startup', () => {
    process.env[DISPATCHER_SPEC_KEY] = 'every:0m';

    expect(() => dispatcher.onModuleInit()).not.toThrow();

    expect(dispatcherSchedules(schedules)).toEqual([
      expect.objectContaining({ spec: 'every:0m', enabled: false }),
    ]);
  });

  it('uses the default only when no persisted or env setting exists', () => {
    dispatcher.onModuleInit();

    expect(dispatcherSchedules(schedules)).toEqual([
      expect.objectContaining({ spec: DEFAULT_DISPATCHER_SPEC, enabled: true }),
    ]);
  });

  it('re-enables the same dispatcher row after an invalid setting is corrected', () => {
    settings.set(DISPATCHER_SPEC_KEY, 'not-a-cadence');
    dispatcher.onModuleInit();
    const invalid = dispatcherSchedules(schedules)[0]!;

    settings.set(DISPATCHER_SPEC_KEY, 'every:5m');
    dispatcher.ensureSchedule();

    const rows = dispatcherSchedules(schedules);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: invalid.id, spec: 'every:5m', enabled: true });
  });
});

function dispatcherSchedules(schedules: SchedulesRepository) {
  return schedules.list().filter(
    (schedule) => schedule.target.kind === 'system' && schedule.target.job === DISPATCHER_JOB,
  );
}
