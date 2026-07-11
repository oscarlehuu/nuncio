import { Module } from '@nestjs/common';
import { AttentionModule } from './attention/attention.module';
import { HeartbeatModule } from './attention/heartbeat/heartbeat.module';
import { FleetModule } from './attention/fleet/fleet.module';
import { AuthModule } from './auth/auth.module';
import { BrowserModule } from './browser/browser.module';
import { ContextModule } from './context/context.module';
import { CrewModule } from './crew/crew.module';
import { CursorLocalModule } from './cursor-local/cursor-local.module';
import { DatabaseModule } from './db/database.module';
import { DevicesModule } from './devices/devices.module';
import { DispatcherModule } from './dispatcher/dispatcher.module';
import { ForgesModule } from './forges/forges.module';
import { FsModule } from './fs/fs.module';
import { GitModule } from './git/git.module';
import { HealthModule } from './health/health.module';
import { HubModule } from './hub/hub.module';
import { LoopsModule } from './loops/loops.module';
import { ModelsModule } from './models/models.module';
import { ObservabilityModule } from './observability/observability.module';
import { PairingModule } from './pairing/pairing.module';
import { PiLocalModule } from './pi-local/pi-local.module';
import { PreferencesModule } from './preferences/preferences.module';
import { PromptsModule } from './prompts/prompts.module';
import { ProviderUpdatesModule } from './provider-updates/provider-updates.module';
import { ProvisionModule } from './provision/provision.module';
import { SchedulerModule } from './scheduler/scheduler.module';
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
    DevicesModule,
    DispatcherModule,
    AttentionModule,
    HeartbeatModule,
    FleetModule,
    AuthModule,
    PairingModule,
    SettingsModule,
    PreferencesModule,
    ProviderUpdatesModule,
    BrowserModule,
    ContextModule,
    CrewModule,
    CursorLocalModule,
    ForgesModule,
    FsModule,
    GitModule,
    HealthModule,
    HubModule,
    LoopsModule,
    ModelsModule,
    PiLocalModule,
    PromptsModule,
    ProvisionModule,
    SchedulerModule,
    SessionsModule,
    TailscaleModule,
    TasksModule,
    TerminalModule,
    ObservabilityModule,
  ],
})
export class AppModule {}
