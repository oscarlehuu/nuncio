import { Module } from '@nestjs/common';
import { EventsRepository } from './persistence/events.repository';
import { ProviderRequestsRepository } from './persistence/provider-requests.repository';
import { SessionsRepository } from './persistence/sessions.repository';
import { SteerQueueRepository } from './persistence/steer-queue.repository';

@Module({
  providers: [SessionsRepository, EventsRepository, ProviderRequestsRepository, SteerQueueRepository],
  exports: [SessionsRepository, EventsRepository, ProviderRequestsRepository, SteerQueueRepository],
})
export class SessionsPersistenceModule {}
