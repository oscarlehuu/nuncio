import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../db/database.module';
import { DigestRepository } from './digest.repository';
import { HeartbeatController } from './heartbeat.controller';
import { HeartbeatService } from './heartbeat.service';
import { InfraChecks } from './infra-checks';

/**
 * Heartbeat (rung 3, sub-phase B). 3 rhythm layers on the rung-2 scheduler.
 * Full wiring (attention seam, scheduler system handler, push broadcast, forge/
 * session probes) lands with the B implementation; this module exists so the red
 * suite resolves. Nothing imports it → pulling feature modules in here later
 * introduces no cycle.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [HeartbeatController],
  providers: [HeartbeatService, InfraChecks, DigestRepository],
  exports: [HeartbeatService],
})
export class HeartbeatModule {}
