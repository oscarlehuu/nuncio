import { Module } from '@nestjs/common';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { PiLocalController } from './pi-local.controller';
import { PiLocalSessionsService } from './pi-local-sessions.service';

@Module({
  imports: [SessionsPersistenceModule],
  controllers: [PiLocalController],
  providers: [PiLocalSessionsService],
  exports: [PiLocalSessionsService],
})
export class PiLocalModule {}
