import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../db/database.module';
import { AttentionModule } from '../attention.module';
import { ForgesModule } from '../../forges/forges.module';
import { GitModule } from '../../git/git.module';
import { LoopsModule } from '../../loops/loops.module';
import { ProjectsModule } from '../../projects/projects.module';
import { SessionsPersistenceModule } from '../../sessions/sessions.persistence.module';
import { SettingsModule } from '../../settings/settings.module';
import { AnomalyCollector } from './anomaly-collector';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';

/**
 * Fleet home + anomaly heuristics (rung 3, sub-phase C). Fleet is derive-on-demand
 * (no store) over projects/sessions/loops/attention/forge rows; the two anomaly
 * collectors register into the AttentionCollectors sweep (15-min cadence). Nothing
 * imports this module, so pulling the feature modules in here introduces no cycle.
 */
@Module({
  imports: [
    DatabaseModule,
    AttentionModule,
    ProjectsModule,
    SessionsPersistenceModule,
    LoopsModule,
    ForgesModule,
    GitModule,
    SettingsModule,
  ],
  controllers: [FleetController],
  providers: [FleetService, AnomalyCollector],
  exports: [FleetService, AnomalyCollector],
})
export class FleetModule {}
