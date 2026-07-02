import { Controller, Get } from '@nestjs/common';
import { HubService } from './hub.service';
import { HubRegistryService, type MachineEntry } from './hub-registry.service';

@Controller('hub')
export class HubController {
  constructor(
    private readonly hub: HubService,
    private readonly registry: HubRegistryService,
  ) {}

  /** Powers the machine switcher: whether this server is a hub + the machines
   * it can reach. Empty machine list when hub mode is off. */
  @Get('machines')
  async machines(): Promise<{ hubMode: boolean; machines: MachineEntry[] }> {
    const hubMode = this.hub.enabled();
    return { hubMode, machines: hubMode ? await this.registry.discover() : [] };
  }
}
