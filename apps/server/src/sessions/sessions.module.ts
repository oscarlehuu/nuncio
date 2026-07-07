import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AgentToolsModule } from '../agents/tools/agent-tools.module';
import { CursorLocalModule } from '../cursor-local/cursor-local.module';
import { GitModule } from '../git/git.module';
import { PiLocalModule } from '../pi-local/pi-local.module';
import { GitSessionController } from './api/git-session.controller';
import { SessionsController } from './api/sessions.controller';
import { SessionsPersistenceModule } from './sessions.persistence.module';
import { SessionsService } from './sessions.service';
import { MediaStore } from './media.store';
import { SettingsModule } from '../settings/settings.module';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [
    AgentsModule,
    AgentToolsModule,
    CursorLocalModule,
    GitModule,
    PiLocalModule,
    SessionsPersistenceModule,
    SettingsModule,
    ProjectsModule,
  ],
  controllers: [SessionsController, GitSessionController],
  providers: [SessionsService, MediaStore],
  exports: [SessionsService],
})
export class SessionsModule {}
