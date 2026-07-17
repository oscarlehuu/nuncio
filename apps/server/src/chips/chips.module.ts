import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AttentionModule } from '../attention/attention.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ChipsController } from './chips.controller';
import { ChipsService } from './chips.service';

/**
 * Session chips (spawn-task). A proposed follow-up an agent flagged mid-turn,
 * stored as an attention item and spun into a lineage-linked child session on
 * one tap. Imports the queue (durability + Home surfacing), the session layer
 * (register the event handler + create the child) and the agent registry (the
 * `capabilities.spawnTask` gate).
 */
@Module({
  imports: [AttentionModule, SessionsModule, AgentsModule],
  controllers: [ChipsController],
  providers: [ChipsService],
  exports: [ChipsService],
})
export class ChipsModule {}
