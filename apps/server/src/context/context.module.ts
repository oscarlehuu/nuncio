import { Module } from '@nestjs/common';
import { ContextFactProposalsRepository } from './context-fact-proposals.repository';
import { ContextFactsController } from './context-facts.controller';
import { ContextFactsRepository } from './context-facts.repository';
import { ContextFactsService } from './context-facts.service';

@Module({
  controllers: [ContextFactsController],
  providers: [ContextFactsRepository, ContextFactProposalsRepository, ContextFactsService],
  exports: [ContextFactsService, ContextFactsRepository],
})
export class ContextModule {}
