import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
} from '@nestjs/common';
import { PreferencesService } from './preferences.service';

/** Body for PUT /api/preferences/:key. */
interface UpdatePreferenceDto {
  value: string;
}

/**
 * REST API for the preferences store — a generic durable key-value store for UI
 * state that must survive app updates (unlike localStorage). Values are opaque
 * strings (usually JSON). GET on a missing key returns null with 200: a pref
 * that was never written is a normal state, not a 404.
 */
@Controller('preferences')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get(':key')
  get(@Param('key') key: string) {
    return this.preferences.get(key);
  }

  @Put(':key')
  update(@Param('key') key: string, @Body() body: UpdatePreferenceDto) {
    if (body === null || body === undefined || typeof body.value !== 'string') {
      throw new BadRequestException('value (string) is required');
    }
    return this.preferences.set(key, body.value);
  }

  @Delete(':key')
  remove(@Param('key') key: string) {
    this.preferences.clear(key);
    return { ok: true };
  }
}
