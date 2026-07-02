import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';

export const HUB_MODE_KEY = 'NUNCIO_HUB_MODE';

/** Hub mode is a per-server toggle (default off). When on, this nuncio also
 * proxies /m/<machine>/ to other tailnet machines running nuncio. */
@Injectable()
export class HubService {
  constructor(private readonly settings: SettingsService) {}

  enabled(): boolean {
    return this.settings.resolve(HUB_MODE_KEY) === '1';
  }
}
