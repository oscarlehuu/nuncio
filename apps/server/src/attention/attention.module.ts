import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { AttentionRepository } from './attention.repository';
import { AttentionService } from './attention.service';

/**
 * Attention queue (rung 3, sub-phase A). Collectors (B/C add more) raise signals
 * into a durable, deduped, ranked queue. Controller + collector wiring land with
 * the sub-phase A implementation; this module exists so the red suite resolves.
 */
@Module({
  imports: [DatabaseModule],
  providers: [AttentionRepository, AttentionService],
  exports: [AttentionService],
})
export class AttentionModule {}
