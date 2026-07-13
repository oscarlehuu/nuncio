import { Module } from '@nestjs/common';
import { EventsRepository } from './persistence/events.repository';
import { ProviderRequestsRepository } from './persistence/provider-requests.repository';
import { SessionsRepository } from './persistence/sessions.repository';
import { SteerQueueRepository } from './persistence/steer-queue.repository';
import { MediaStore } from './media.store';

@Module({
  providers: [SessionsRepository, EventsRepository, ProviderRequestsRepository, SteerQueueRepository, MediaStore],
  exports: [SessionsRepository, EventsRepository, ProviderRequestsRepository, SteerQueueRepository, MediaStore],
})
export class SessionsPersistenceModule {}
