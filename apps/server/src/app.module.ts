import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { HealthModule } from './health/health.module';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [DatabaseModule, HealthModule, SessionsModule],
})
export class AppModule {}
