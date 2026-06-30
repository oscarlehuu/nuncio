import { Module } from '@nestjs/common';
import { EventsRepository } from './persistence/events.repository';
import { ProviderRequestsRepository } from './persistence/provider-requests.repository';
import { SessionsRepository } from './persistence/sessions.repository';

@Module({
  providers: [SessionsRepository, EventsRepository, ProviderRequestsRepository],
  exports: [SessionsRepository, EventsRepository, ProviderRequestsRepository],
})
export class SessionsPersistenceModule {}
