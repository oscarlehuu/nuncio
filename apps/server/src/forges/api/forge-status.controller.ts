import { Controller, Get } from '@nestjs/common';
import { ForgesService } from '../forges.service';
import type { ForgeStatusDto } from '../forges.types';

@Controller('forges')
export class ForgeStatusController {
  constructor(private readonly forges: ForgesService) {}

  @Get()
  getStatus(): Promise<ForgeStatusDto[]> {
    return this.forges.listStatus();
  }
}
