import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AttentionModule } from '../attention/attention.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ReproduceController } from './reproduce.controller';
import { ReproduceService } from './reproduce.service';

/**
 * Debug reproduction gate (D2). A paused debug run stored as an attention item;
 * the user runs the steps, captures logs, then Proceed/Mark-Fixed resumes the
 * run through the existing steer path. Imports the queue (durability + Home
 * surfacing), the session layer (register the event handler + steer) and the
 * agent registry (the `capabilities.reproduceGate` gate).
 */
@Module({
  imports: [AttentionModule, SessionsModule, AgentsModule],
  controllers: [ReproduceController],
  providers: [ReproduceService],
  exports: [ReproduceService],
})
export class ReproduceModule {}
