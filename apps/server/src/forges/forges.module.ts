import { Module } from '@nestjs/common';
import { GitModule } from '../git/git.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { SettingsModule } from '../settings/settings.module';
import { ForgesController } from './api/forges.controller';
import { ForgeStatusController } from './api/forge-status.controller';
import { ForgeRegistry } from './forges.registry';
import { ForgesService } from './forges.service';
import { GithubForgeProvider } from './providers/github-forge.provider';
import { GitlabForgeProvider } from './providers/gitlab-forge.provider';
import { WebhooksController } from './webhooks/webhooks.controller';
import { WebhooksService } from './webhooks/webhooks.service';

@Module({
  imports: [SettingsModule, GitModule, SessionsPersistenceModule, SessionsModule],
  controllers: [ForgesController, ForgeStatusController, WebhooksController],
  providers: [GithubForgeProvider, GitlabForgeProvider, ForgeRegistry, ForgesService, WebhooksService],
  exports: [ForgeRegistry, ForgesService],
})
export class ForgesModule {}
