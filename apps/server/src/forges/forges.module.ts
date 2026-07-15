import { forwardRef, Module } from '@nestjs/common';
import { AttentionModule } from '../attention/attention.module';
import { GitModule } from '../git/git.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { SettingsModule } from '../settings/settings.module';
import { ForgesController } from './api/forges.controller';
import { ForgeRepoController } from './api/forge-repo.controller';
import { ForgeStatusController } from './api/forge-status.controller';
import { SessionsFromPullRequestController } from './api/sessions-from-pr.controller';
import { ForgeRegistry } from './forges.registry';
import { ForgeRepoService } from './forges-repo.service';
import { ForgesService } from './forges.service';
import { GithubForgeProvider } from './providers/github-forge.provider';
import { GitlabForgeProvider } from './providers/gitlab-forge.provider';
import { WebhooksController } from './webhooks/webhooks.controller';
import { WebhooksService } from './webhooks/webhooks.service';

@Module({
  imports: [
    SettingsModule,
    GitModule,
    SessionsPersistenceModule,
    SessionsModule,
    forwardRef(() => AttentionModule),
  ],
  controllers: [
    ForgesController,
    ForgeRepoController,
    ForgeStatusController,
    SessionsFromPullRequestController,
    WebhooksController,
  ],
  providers: [
    GithubForgeProvider,
    GitlabForgeProvider,
    ForgeRegistry,
    ForgesService,
    ForgeRepoService,
    WebhooksService,
  ],
  exports: [ForgeRegistry, ForgesService, ForgeRepoService],
})
export class ForgesModule {}
