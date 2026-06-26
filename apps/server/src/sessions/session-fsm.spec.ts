import { canTransition } from './session-fsm';

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
});
