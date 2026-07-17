import { describe, it, expect } from 'bun:test';
import {
  SESSION_MODES,
  assertModeSupported,
  isSessionMode,
  modeOverlay,
  toSessionModeOrNull,
  type SessionMode,
} from '../../../src/sessions/domain/session-modes';

describe('session-modes', () => {
  describe('isSessionMode / toSessionModeOrNull', () => {
    it('accepts the known modes', () => {
      expect(isSessionMode('debug')).toBe(true);
      expect(isSessionMode('multitask')).toBe(true);
      expect(SESSION_MODES).toEqual(['debug', 'multitask']);
    });

    it('rejects unknown / empty / non-string values', () => {
      expect(isSessionMode('agent')).toBe(false);
      expect(isSessionMode('')).toBe(false);
      expect(isSessionMode(null)).toBe(false);
      expect(isSessionMode(undefined)).toBe(false);
      expect(isSessionMode(42)).toBe(false);
    });

    it('coerces stored values to a mode or null', () => {
      expect(toSessionModeOrNull('debug')).toBe('debug');
      expect(toSessionModeOrNull('bogus')).toBeNull();
      expect(toSessionModeOrNull(null)).toBeNull();
    });
  });

  describe('assertModeSupported', () => {
    it('is a no-op when no mode is requested', () => {
      expect(() => assertModeSupported(undefined, undefined)).not.toThrow();
      expect(() => assertModeSupported(null, ['debug'])).not.toThrow();
    });

    it('accepts a mode the provider lists', () => {
      expect(() => assertModeSupported('debug', ['debug', 'multitask'])).not.toThrow();
    });

    it('rejects a mode the provider does not list', () => {
      expect(() => assertModeSupported('multitask', ['debug'])).toThrow(/not supported/);
    });

    it('rejects any mode when the provider supports none', () => {
      expect(() => assertModeSupported('debug', undefined)).toThrow(/not supported/);
      expect(() => assertModeSupported('debug', [])).toThrow(/not supported/);
    });

    it('rejects an unknown mode string outright', () => {
      expect(() => assertModeSupported('nope' as SessionMode, ['debug'])).toThrow(/Unknown session mode/);
    });
  });

  describe('modeOverlay', () => {
    it('returns empty string for the normal agent (no mode)', () => {
      expect(modeOverlay(null)).toBe('');
      expect(modeOverlay(undefined)).toBe('');
    });

    it('debug overlay is hypothesis-first with a removable sentinel', () => {
      const overlay = modeOverlay('debug');
      expect(overlay.toLowerCase()).toContain('hypothes');
      expect(overlay).toContain('// nuncio-debug');
      expect(overlay.toLowerCase()).toContain('remove');
      // Never fix before evidence.
      expect(overlay.toLowerCase()).toContain('confirm');
      // D1: the protocol routes diagnosis through the reproduction gate.
      expect(overlay).toContain('request_reproduction');
    });

    it('multitask overlay frames a decompose-into-parallel-subtasks split', () => {
      const overlay = modeOverlay('multitask');
      expect(overlay.toLowerCase()).toContain('decompose');
      expect(overlay.toLowerCase()).toContain('independent');
      expect(overlay.toLowerCase()).toContain('parallel');
      // Plan the split explicitly (execution lands later).
      expect(overlay.toLowerCase()).toContain('split');
    });
  });
});
