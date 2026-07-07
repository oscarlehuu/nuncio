import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { SettingsModule } from '../settings/settings.module';
import { ProjectDefaultsResolver } from './project-defaults-resolver';
import { ProjectsController } from './projects.controller';
import { ProjectsRepository } from './projects.repository';

/**
 * Per-project config entity (rung 2 sub-phase A): the durable config layer that
 * loops and the fleet view stand on. Keyed by path, distinct from the
 * recent_projects MRU picker; a soft reference from sessions/tasks.
 */
@Module({
  imports: [DatabaseModule, SettingsModule],
  controllers: [ProjectsController],
  providers: [ProjectsRepository, ProjectDefaultsResolver],
  exports: [ProjectsRepository, ProjectDefaultsResolver],
})
export class ProjectsModule {}
