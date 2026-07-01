import { Module } from '@nestjs/common';
import { CursorLocalModule } from './cursor-local/cursor-local.module';
import { DatabaseModule } from './db/database.module';
import { ForgesModule } from './forges/forges.module';
import { FsModule } from './fs/fs.module';
import { GitModule } from './git/git.module';
import { HealthModule } from './health/health.module';
import { ModelsModule } from './models/models.module';
import { PiLocalModule } from './pi-local/pi-local.module';
import { SessionsModule } from './sessions/sessions.module';
import { SettingsModule } from './settings/settings.module';

@Module({
  imports: [
    DatabaseModule,
    SettingsModule,
    CursorLocalModule,
    ForgesModule,
    FsModule,
    GitModule,
    HealthModule,
    ModelsModule,
    PiLocalModule,
    SessionsModule,
  ],
})
export class AppModule {}
