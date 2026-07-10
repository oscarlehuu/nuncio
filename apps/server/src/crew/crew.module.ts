import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AgentToolsModule } from '../agents/tools/agent-tools.module';
import { AttentionModule } from '../attention/attention.module';
import { GitModule } from '../git/git.module';
import { ProjectsModule } from '../projects/projects.module';
import { PushModule } from '../push/push.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TasksModule } from '../tasks/tasks.module';
import { SettingsModule } from '../settings/settings.module';
import { CrewController } from './api/crew.controller';
import { CrewProfileResolver } from './crew-profile.resolver';
import { CrewPushNotifier } from './crew-push-notifier.service';
import { CrewProviderCatalogService } from './crew-provider-catalog.service';
import { CrewPersistenceModule } from './crew.persistence.module';
import { CrewService } from './crew.service';
import { CrewVerifyCommandResolver } from './crew-verify-command.resolver';
import { CrewArtifactStore } from './crew-artifact.store';
import { CrewAttentionAdapter } from './crew-attention.adapter';
import { CrewBuildFinalizerService } from './crew-build-finalizer.service';
import { CrewBuildRecoveryFinalizerService } from './crew-build-recovery-finalizer.service';
import { CrewCommandRunner } from './crew-command.runner';
import {
  CREW_ATTENTION_PORT, CREW_MEMBER_EXECUTION_PORT, CREW_WORKSPACE_PORT,
} from './crew-execution.ports';
import { CrewGateEvidenceService } from './crew-gate-evidence.service';
import { CrewGitWorkspaceAdapter } from './crew-git-workspace.adapter';
import { CrewMemberService } from './crew-member.service';
import { CrewReviewEvidenceService } from './crew-review-evidence.service';
import { CrewRunnerService } from './crew-runner.service';
import { CrewRunnerExecutionService } from './crew-runner-execution.service';
import { CrewRunQuiescerService } from './crew-run-quiescer.service';
import { CrewRunnerBlockerService } from './crew-runner-blocker.service';
import { CrewRunQueryService } from './crew-run-query.service';
import { CrewRunControlService } from './crew-run-control.service';
import { CrewRuntimeToolsService } from './crew-runtime-tools.service';
import { CrewRuntimeMemberResolver } from './crew-runtime-member-resolver.service';
import { CrewStageResultsService } from './crew-stage-results.service';
import { CrewTaskExecutionAdapter } from './crew-task-execution.adapter';
import { CrewVerifierService } from './crew-verifier.service';
import { CrewWriterLeaseService } from './crew-writer-lease.service';
import { CrewContextService } from './crew-context.service';
import { CrewRecoveryService } from './crew-recovery.service';
import { CrewSuccessorService } from './crew-successor.service';

@Module({
  imports: [
    AgentsModule, AgentToolsModule, AttentionModule, GitModule, ProjectsModule,
    SessionsModule, SettingsModule, TasksModule, PushModule, CrewPersistenceModule,
  ],
  controllers: [CrewController],
  providers: [
    CrewProfileResolver, CrewProviderCatalogService, CrewVerifyCommandResolver,
    CrewArtifactStore, CrewCommandRunner, CrewContextService, CrewWriterLeaseService,
    CrewGitWorkspaceAdapter, CrewTaskExecutionAdapter, CrewAttentionAdapter,
    { provide: CREW_WORKSPACE_PORT, useExisting: CrewGitWorkspaceAdapter },
    { provide: CREW_MEMBER_EXECUTION_PORT, useExisting: CrewTaskExecutionAdapter },
    { provide: CREW_ATTENTION_PORT, useExisting: CrewAttentionAdapter },
    CrewMemberService, CrewVerifierService, CrewReviewEvidenceService, CrewGateEvidenceService,
    CrewRuntimeMemberResolver, CrewRuntimeToolsService, CrewBuildFinalizerService,
    CrewBuildRecoveryFinalizerService, CrewStageResultsService,
    CrewRunnerExecutionService, CrewRunQuiescerService, CrewRunnerBlockerService,
    CrewRunQueryService, CrewRunnerService, CrewRunControlService,
    CrewRecoveryService, CrewSuccessorService, CrewService,
    CrewPushNotifier,
  ],
  exports: [CrewService, CrewProfileResolver, CrewRunnerService],
})
export class CrewModule {}
