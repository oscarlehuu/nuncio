import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { ContextFactsService } from './context-facts.service';

@Controller('context-facts')
export class ContextFactsController {
  constructor(private readonly facts: ContextFactsService) {}

  @Get()
  list(@Query('projectPath') projectPath?: string) {
    const path = projectPath?.trim();
    if (!path) throw new BadRequestException('projectPath is required');
    return this.facts.list(path);
  }

  @Put()
  upsert(@Body() body: { projectPath?: string; key?: string; value?: string; pinned?: boolean }) {
    // UI/CLI writes are always founder-provenance.
    const outcome = this.facts.upsert({
      projectPath: body?.projectPath ?? '',
      key: body?.key ?? '',
      value: body?.value ?? '',
      provenance: 'founder',
      pinned: body?.pinned === true,
    });
    return outcome.fact;
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    if (!this.facts.delete(id)) throw new NotFoundException('Fact not found');
    return { ok: true };
  }

  @Get('proposals')
  listProposals(@Query('projectPath') projectPath?: string) {
    const path = projectPath?.trim();
    if (!path) throw new BadRequestException('projectPath is required');
    return this.facts.listProposals(path);
  }

  @Post('proposals/:id/accept')
  acceptProposal(@Param('id') id: string) {
    const accepted = this.facts.acceptProposal(id);
    if (!accepted) throw new NotFoundException('Pending proposal not found');
    return accepted;
  }

  @Post('proposals/:id/dismiss')
  dismissProposal(@Param('id') id: string) {
    const dismissed = this.facts.dismissProposal(id);
    if (!dismissed) throw new NotFoundException('Pending proposal not found');
    return dismissed;
  }
}
