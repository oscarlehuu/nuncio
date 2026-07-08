import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_MAX_ROUNDS,
  parseAutoSteerEnabled,
  parseMaxRounds,
} from '../../../src/sessions/verify-feedback';

describe('verify-feedback settings parsing', () => {
  describe('parseAutoSteerEnabled', () => {
    it('enables only on "1"/"true" (case-insensitive), disables otherwise', () => {
      expect(parseAutoSteerEnabled('1')).toBe(true);
      expect(parseAutoSteerEnabled('true')).toBe(true);
      expect(parseAutoSteerEnabled('TRUE')).toBe(true);
      expect(parseAutoSteerEnabled('0')).toBe(false);
      expect(parseAutoSteerEnabled('false')).toBe(false);
      expect(parseAutoSteerEnabled('')).toBe(false);
      expect(parseAutoSteerEnabled('yesplease')).toBe(false);
      expect(parseAutoSteerEnabled(undefined)).toBe(false);
    });
  });

  describe('parseMaxRounds', () => {
    it('accepts non-negative integers verbatim, including 0', () => {
      expect(parseMaxRounds('0')).toBe(0);
      expect(parseMaxRounds('2')).toBe(2);
      expect(parseMaxRounds('10')).toBe(10);
    });

    it('clamps negatives, fractions, and non-numeric to the default', () => {
      expect(parseMaxRounds('-5')).toBe(DEFAULT_MAX_ROUNDS);
      expect(parseMaxRounds('2.7')).toBe(DEFAULT_MAX_ROUNDS);
      expect(parseMaxRounds('lots')).toBe(DEFAULT_MAX_ROUNDS);
      expect(parseMaxRounds(undefined)).toBe(DEFAULT_MAX_ROUNDS);
    });

    it('treats empty and whitespace-only as invalid → default (not max-rounds-0)', () => {
      // Number('') === 0 would silently disable the loop for a blank setting.
      expect(parseMaxRounds('')).toBe(DEFAULT_MAX_ROUNDS);
      expect(parseMaxRounds('   ')).toBe(DEFAULT_MAX_ROUNDS);
      expect(parseMaxRounds('\t\n')).toBe(DEFAULT_MAX_ROUNDS);
    });
  });
});
