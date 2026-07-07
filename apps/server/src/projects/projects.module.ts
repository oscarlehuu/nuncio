import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { SettingsModule } from '../settings/settings.module';
import { ProjectDefaultsResolver } from './project-defaults-resolver';
import { ProjectsRepository } from './projects.repository';

/**
 * Per-project config entity (rung 2 sub-phase A): the durable config layer that
 * loops and the fleet view stand on. Skeleton wiring — the repository/resolver
 * are driven red-first by the sub-phase A suite.
 */
@Module({
  imports: [DatabaseModule, SettingsModule],
  providers: [ProjectsRepository, ProjectDefaultsResolver],
  exports: [ProjectsRepository, ProjectDefaultsResolver],
})
export class ProjectsModule {}
