import { Module } from '@nestjs/common';
import { EventsRepository } from './events.repository';
import { MockAgentService } from './mock-agent.service';
import { PiAgentService } from './pi-agent.service';
import { SessionsController } from './sessions.controller';
import { SessionsRepository } from './sessions.repository';
import { SessionsService } from './sessions.service';

@Module({
  controllers: [SessionsController],
  providers: [
    SessionsRepository,
    EventsRepository,
    MockAgentService,
    PiAgentService,
    SessionsService,
  ],
})
export class SessionsModule {}
