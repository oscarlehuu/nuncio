import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Put,
} from '@nestjs/common';
import type { UpdateSettingDto } from '../settings.types';
import { SettingsService } from '../settings.service';

/**
 * REST API for the settings store.
 *
 * Secret-typed values are masked by the service before they leave this endpoint
 * — raw credentials never appear in any GET response. Writes go through
 * `service.set()` (which encrypts secrets at rest) and `service.clear()`
 * (which removes the DB row so resolve falls back to env/default).
 */
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  list() {
    return this.settings.list();
  }

  @Get(':key')
  get(@Param('key') key: string) {
    const dto = this.settings.get(key);
    if (!dto) throw new NotFoundException(`unknown setting: ${key}`);
    return dto;
  }

  @Put(':key')
  update(@Param('key') key: string, @Body() body: UpdateSettingDto) {
    if (body === null || body === undefined || typeof body.value !== 'string') {
      throw new BadRequestException('value (string) is required');
    }
    this.settings.set(key, body.value);
    return this.settings.get(key);
  }

  @Delete(':key')
  remove(@Param('key') key: string) {
    this.settings.clear(key);
    return this.settings.get(key);
  }
}
