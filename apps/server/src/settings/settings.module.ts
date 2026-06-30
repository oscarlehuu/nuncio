import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { DatabaseService } from '../db/database.service';
import { SettingsController } from './api/settings.controller';
import { loadSettingsKey } from './settings.crypto';
import { SettingsRepository } from './persistence/settings.repository';
import { SETTINGS_KEY, SettingsService } from './settings.service';

/**
 * Wires the settings store. The AES-256-GCM key is loaded once at boot from
 * `NUNCIO_SETTINGS_KEY` (env) or a generated `data/settings.key` file — see
 * `loadSettingsKey` for the resolution order.
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    SettingsRepository,
    {
      provide: SETTINGS_KEY,
      inject: [DatabaseService],
      useFactory: (db: DatabaseService) => loadSettingsKey(db.dataDir),
    },
    SettingsService,
  ],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
