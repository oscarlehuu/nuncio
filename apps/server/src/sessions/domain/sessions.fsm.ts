import { BadRequestException } from '@nestjs/common';
import type { SessionStatus } from './sessions.types';

const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  CREATED: ['RUNNING', 'ERROR'],
  RUNNING: ['IDLE', 'ERROR', 'PAUSED'],
  IDLE: ['RUNNING', 'ERROR', 'PAUSED', 'ARCHIVED'],
  PAUSED: ['RUNNING', 'ARCHIVED'],
  ARCHIVED: ['IDLE'],
  ERROR: ['RUNNING', 'IDLE', 'ARCHIVED'],
};

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new BadRequestException(`Invalid transition ${from} -> ${to}`);
  }
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
