import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { CloneService } from './clone.service';
import { GitController } from './git.controller';
import { GitService } from './git.service';
import { RecentProjectsRepository } from './recent-projects.repository';

@Module({
  imports: [SettingsModule],
  controllers: [GitController],
  providers: [GitService, RecentProjectsRepository, CloneService],
  exports: [GitService, RecentProjectsRepository],
})
export class GitModule {}
