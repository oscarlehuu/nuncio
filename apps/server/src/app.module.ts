import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { GitModule } from './git/git.module';
import { HealthModule } from './health/health.module';
import { ModelsModule } from './models/models.module';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [DatabaseModule, GitModule, HealthModule, ModelsModule, SessionsModule],
})
export class AppModule {}
