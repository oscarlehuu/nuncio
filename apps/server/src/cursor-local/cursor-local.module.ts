import { Module } from '@nestjs/common';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { CursorLocalController } from './cursor-local.controller';
import { CursorLocalSessionsService } from './cursor-local-sessions.service';

@Module({
  imports: [SessionsPersistenceModule],
  controllers: [CursorLocalController],
  providers: [CursorLocalSessionsService],
  exports: [CursorLocalSessionsService],
})
export class CursorLocalModule {}
