import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../db/database.module';
import { AnomalyCollector } from './anomaly-collector';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';

/**
 * Fleet home + anomaly heuristics (rung 3, sub-phase C). Fleet is derive-on-demand
 * (no store). Full wiring (projects/sessions/loops/attention/forge/git reads, and
 * hooking the anomaly collectors into the AttentionCollectors sweep) lands with the
 * C implementation; this module exists so the red suite resolves. Nothing imports
 * it → pulling feature modules in here later introduces no cycle.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [FleetController],
  providers: [FleetService, AnomalyCollector],
  exports: [FleetService, AnomalyCollector],
})
export class FleetModule {}
