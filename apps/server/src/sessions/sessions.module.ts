import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { CursorLocalModule } from '../cursor-local/cursor-local.module';
import { GitModule } from '../git/git.module';
import { SessionsController } from './api/sessions.controller';
import { SessionsPersistenceModule } from './sessions.persistence.module';
import { SessionsService } from './sessions.service';

@Module({
  imports: [AgentsModule, CursorLocalModule, GitModule, SessionsPersistenceModule],
  controllers: [SessionsController],
  providers: [SessionsService],
})
export class SessionsModule {}
