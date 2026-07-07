import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { BrowserModule } from './browser/browser.module';
import { ContextModule } from './context/context.module';
import { CursorLocalModule } from './cursor-local/cursor-local.module';
import { DatabaseModule } from './db/database.module';
import { ForgesModule } from './forges/forges.module';
import { FsModule } from './fs/fs.module';
import { GitModule } from './git/git.module';
import { HealthModule } from './health/health.module';
import { HubModule } from './hub/hub.module';
import { ModelsModule } from './models/models.module';
import { PiLocalModule } from './pi-local/pi-local.module';
import { PreferencesModule } from './preferences/preferences.module';
import { ProviderUpdatesModule } from './provider-updates/provider-updates.module';
import { ProvisionModule } from './provision/provision.module';
import { SessionsModule } from './sessions/sessions.module';
import { SettingsModule } from './settings/settings.module';
import { TailscaleModule } from './tailscale/tailscale.module';
import { TasksModule } from './tasks/tasks.module';
import { TerminalModule } from './terminal/terminal.module';
import { PushModule } from './push/push.module';

@Module({
  imports: [
    PushModule,
    DatabaseModule,
    AuthModule,
    SettingsModule,
    PreferencesModule,
    ProviderUpdatesModule,
    BrowserModule,
    ContextModule,
    CursorLocalModule,
    ForgesModule,
    FsModule,
    GitModule,
    HealthModule,
    HubModule,
    ModelsModule,
    PiLocalModule,
    ProvisionModule,
    SessionsModule,
    TailscaleModule,
    TasksModule,
    TerminalModule,
  ],
})
export class AppModule {}
