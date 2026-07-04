import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { PreferencesController } from './preferences.controller';
import { PreferencesRepository } from './preferences.repository';
import { PreferencesService } from './preferences.service';

/**
 * Wires the preferences store — a registry-free, encryption-free durable
 * key-value store backing UI state that must survive app updates.
 */
@Module({
  imports: [DatabaseModule],
  providers: [PreferencesRepository, PreferencesService],
  controllers: [PreferencesController],
  exports: [PreferencesService],
})
export class PreferencesModule {}
