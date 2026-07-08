import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AgentToolsModule } from '../agents/tools/agent-tools.module';
import { ContextModule } from '../context/context.module';
import { CursorLocalModule } from '../cursor-local/cursor-local.module';
import { GitModule } from '../git/git.module';
import { PiLocalModule } from '../pi-local/pi-local.module';
import { PromptsModule } from '../prompts/prompts.module';
import { GitSessionController } from './api/git-session.controller';
import { SessionsController } from './api/sessions.controller';
import { SessionDiffController } from './diff/session-diff.controller';
import { SessionDiffService } from './diff/session-diff.service';
import { SessionsPersistenceModule } from './sessions.persistence.module';
import { SessionsService } from './sessions.service';
import { MediaStore } from './media.store';
import { SettingsModule } from '../settings/settings.module';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [
    AgentsModule,
    AgentToolsModule,
    ContextModule,
    CursorLocalModule,
    GitModule,
    PiLocalModule,
    PromptsModule,
    SessionsPersistenceModule,
    SettingsModule,
    ProjectsModule,
  ],
  controllers: [SessionsController, GitSessionController, SessionDiffController],
  providers: [SessionsService, SessionDiffService, MediaStore],
  exports: [SessionsService],
})
export class SessionsModule {}
