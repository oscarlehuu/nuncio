import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { FsModule } from './fs/fs.module';
import { GitModule } from './git/git.module';
import { HealthModule } from './health/health.module';
import { ModelsModule } from './models/models.module';
import { SessionsModule } from './sessions/sessions.module';
import { SettingsModule } from './settings/settings.module';

@Module({
  imports: [
    DatabaseModule,
    SettingsModule,
    FsModule,
    GitModule,
    HealthModule,
    ModelsModule,
    SessionsModule,
  ],
})
export class AppModule {}
