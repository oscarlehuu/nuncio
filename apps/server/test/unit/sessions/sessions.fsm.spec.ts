import { BadRequestException } from '@nestjs/common';
import { assertTransition, canTransition } from '../../../src/sessions/domain/sessions.fsm';

describe('session-fsm', () => {
  it('allows CREATED -> RUNNING', () => {
    expect(canTransition('CREATED', 'RUNNING')).toBe(true);
  });

  it('blocks CREATED -> IDLE', () => {
    expect(canTransition('CREATED', 'IDLE')).toBe(false);
  });

  it('allows RUNNING -> IDLE', () => {
    expect(canTransition('RUNNING', 'IDLE')).toBe(true);
  });

  it('allows IDLE -> RUNNING for steer', () => {
    expect(canTransition('IDLE', 'RUNNING')).toBe(true);
  });

  describe('phase 3 — PAUSED', () => {
    it('allows RUNNING -> PAUSED', () => {
      expect(canTransition('RUNNING', 'PAUSED')).toBe(true);
    });

    it('allows IDLE -> PAUSED', () => {
      expect(canTransition('IDLE', 'PAUSED')).toBe(true);
    });

    it('allows PAUSED -> RUNNING for steer/resume', () => {
      expect(canTransition('PAUSED', 'RUNNING')).toBe(true);
    });

    it('blocks CREATED -> PAUSED', () => {
      expect(canTransition('CREATED', 'PAUSED')).toBe(false);
    });

    it('blocks ARCHIVED -> PAUSED', () => {
      expect(canTransition('ARCHIVED', 'PAUSED')).toBe(false);
    });
  });

  describe('phase 3 — ARCHIVED', () => {
    it('allows IDLE -> ARCHIVED', () => {
      expect(canTransition('IDLE', 'ARCHIVED')).toBe(true);
    });

    it('allows PAUSED -> ARCHIVED', () => {
      expect(canTransition('PAUSED', 'ARCHIVED')).toBe(true);
    });

    it('allows ERROR -> ARCHIVED', () => {
      expect(canTransition('ERROR', 'ARCHIVED')).toBe(true);
    });

    it('blocks RUNNING -> ARCHIVED', () => {
      expect(canTransition('RUNNING', 'ARCHIVED')).toBe(false);
    });

    it('blocks CREATED -> ARCHIVED', () => {
      expect(canTransition('CREATED', 'ARCHIVED')).toBe(false);
    });

    it('blocks transitions from ARCHIVED except restore to IDLE', () => {
      expect(canTransition('ARCHIVED', 'RUNNING')).toBe(false);
      expect(canTransition('ARCHIVED', 'PAUSED')).toBe(false);
      expect(canTransition('ARCHIVED', 'ERROR')).toBe(false);
    });

    it('allows ARCHIVED -> IDLE for restore', () => {
      expect(canTransition('ARCHIVED', 'IDLE')).toBe(true);
    });
  });

  describe('assertTransition', () => {
    it('throws BadRequestException on an invalid transition', () => {
      expect(() => assertTransition('CREATED', 'IDLE')).toThrow(BadRequestException);
      expect(() => assertTransition('ARCHIVED', 'RUNNING')).toThrow(BadRequestException);
    });

    it('passes silently on a valid transition', () => {
      expect(() => assertTransition('IDLE', 'RUNNING')).not.toThrow();
      expect(() => assertTransition('RUNNING', 'PAUSED')).not.toThrow();
    });
  });
});
