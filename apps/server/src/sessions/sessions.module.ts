import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { CursorLocalModule } from '../cursor-local/cursor-local.module';
import { GitModule } from '../git/git.module';
import { PiLocalModule } from '../pi-local/pi-local.module';
import { GitSessionController } from './api/git-session.controller';
import { SessionsController } from './api/sessions.controller';
import { SessionsPersistenceModule } from './sessions.persistence.module';
import { SessionsService } from './sessions.service';

@Module({
  imports: [AgentsModule, CursorLocalModule, GitModule, PiLocalModule, SessionsPersistenceModule],
  controllers: [SessionsController, GitSessionController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
