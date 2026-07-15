import { forwardRef, Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { ForgesModule } from '../forges/forges.module';
import { GitModule } from '../git/git.module';
import { LoopsModule } from '../loops/loops.module';
import { ProjectsModule } from '../projects/projects.module';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { AttentionCollectors } from './attention-collectors';
import { AttentionController } from './attention.controller';
import { AttentionRepository } from './attention.repository';
import { AttentionService } from './attention.service';

/**
 * Attention queue (rung 3, sub-phase A). ONE ranked queue of everything needing
 * the founder. Collectors watch EXISTING rung-1/2 signals (session interaction
 * requests, verify-dead, broken loops, PRs awaiting review) and raise durable,
 * deduped, ranked items. Nothing imports this module, so pulling the feature
 * modules in here introduces no cycle. The heartbeat (sub-phase B) will drive
 * `AttentionCollectors.sweep()` on a cadence.
 */
@Module({
  imports: [
    DatabaseModule,
    ProjectsModule,
    LoopsModule,
    forwardRef(() => ForgesModule),
    GitModule,
    SessionsPersistenceModule,
  ],
  controllers: [AttentionController],
  providers: [AttentionRepository, AttentionService, AttentionCollectors],
  exports: [AttentionService, AttentionCollectors, AttentionRepository],
})
export class AttentionModule {}
