import { Module } from '@nestjs/common';
import { EventsRepository } from './persistence/events.repository';
import { SessionsRepository } from './persistence/sessions.repository';

@Module({
  providers: [SessionsRepository, EventsRepository],
  exports: [SessionsRepository, EventsRepository],
})
export class SessionsPersistenceModule {}
