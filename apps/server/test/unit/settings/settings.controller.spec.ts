import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SettingsController } from '../../../src/settings/api/settings.controller';
import type { SettingDto } from '../../../src/settings/settings.types';

function makeDto(over: Partial<SettingDto> = {}): SettingDto {
  return {
    key: 'CURSOR_API_KEY',
    category: 'provider',
    providerId: 'cursor',
    type: 'secret',
    label: 'Cursor API Key',
    description: 'd',
    hasValue: false,
    source: null,
    value: null,
    readOnly: false,
    ...over,
  };
}

describe('SettingsController', () => {
  describe('list', () => {
    it('delegates to service.list()', () => {
      const list = jest.fn(() => [makeDto({ key: 'A' }), makeDto({ key: 'B' })]);
      const controller = new SettingsController({ list } as never);
      expect(controller.list()).toHaveLength(2);
      expect(list).toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns the DTO for a known key', () => {
      const dto = makeDto({ key: 'CURSOR_API_KEY', hasValue: true, value: '••••12ab' });
      const controller = new SettingsController({ get: () => dto } as never);
      expect(controller.get('CURSOR_API_KEY')).toBe(dto);
    });

    it('throws NotFoundException when the key is unknown', () => {
      const controller = new SettingsController({ get: () => null } as never);
      expect(() => controller.get('NOPE')).toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('calls service.set and returns the updated DTO', () => {
      const set = jest.fn();
      const updated = makeDto({ hasValue: true, source: 'db', value: '••••xyz' });
      const get = jest.fn(() => updated);
      const controller = new SettingsController({ set, get } as never);

      const result = controller.update('CURSOR_API_KEY', { value: 'sk-new' });

      expect(set).toHaveBeenCalledWith('CURSOR_API_KEY', 'sk-new');
      expect(result).toBe(updated);
    });

    it('rejects a missing value field with BadRequestException', () => {
      const controller = new SettingsController({} as never);
      expect(() => controller.update('CURSOR_API_KEY', {} as never)).toThrow(BadRequestException);
    });

    it('allows an explicit empty string (override to blank)', () => {
      const set = jest.fn();
      const updated = makeDto({ hasValue: true, source: 'db', value: null });
      const controller = new SettingsController({ set, get: () => updated } as never);
      expect(() => controller.update('CURSOR_API_KEY', { value: '' })).not.toThrow();
      expect(set).toHaveBeenCalledWith('CURSOR_API_KEY', '');
    });

    it('propagates BadRequestException from service.set for an unknown key', () => {
      const set = jest.fn(() => {
        throw new BadRequestException('unknown setting key: NOPE');
      });
      const controller = new SettingsController({ set } as never);
      expect(() => controller.update('NOPE', { value: 'x' })).toThrow(BadRequestException);
    });
  });

  describe('remove', () => {
    it('calls service.clear and returns the resulting DTO (env/default fallback)', () => {
      const clear = jest.fn();
      const after = makeDto({ hasValue: false, source: null, value: null });
      const get = jest.fn(() => after);
      const controller = new SettingsController({ clear, get } as never);

      const result = controller.remove('CURSOR_API_KEY');

      expect(clear).toHaveBeenCalledWith('CURSOR_API_KEY');
      expect(result).toBe(after);
    });

    it('propagates BadRequestException from service.clear for an unknown key', () => {
      const clear = jest.fn(() => {
        throw new BadRequestException('unknown setting key: NOPE');
      });
      const controller = new SettingsController({ clear } as never);
      expect(() => controller.remove('NOPE')).toThrow(BadRequestException);
    });
  });
});
