import { describe, expect, it } from 'vitest';
import { computeSessionNotifications, type PrevSessionMap } from './use-session-notifications';
import type { Session } from './api';

function makeSession(overrides: Partial<Session> & { id: string; status: Session['status'] }): Session {
  const { id, status, title, ...rest } = overrides;
  return {
    id,
    title: title ?? `Session ${id}`,
    status,
    provider: 'cursor',
    model: null,
    modelOptions: null,
    prompt: '',
    preview: null,
    workspace: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: false,
    createdAt: 0,
    updatedAt: 0,
    ...rest,
  };
}

describe('computeSessionNotifications', () => {
  it('fires "finished" on RUNNING -> IDLE', () => {
    const prev: PrevSessionMap = new Map([['a', { status: 'RUNNING' }]]);
    const sessions = [makeSession({ id: 'a', status: 'IDLE' })];

    const { events } = computeSessionNotifications(prev, sessions, null);

    expect(events).toEqual([
      { kind: 'finished', title: 'Session finished', body: 'Session a', sessionId: 'a' },
    ]);
  });

  it('fires "error" on any transition to ERROR', () => {
    const prev: PrevSessionMap = new Map([['a', { status: 'RUNNING' }]]);
    const sessions = [makeSession({ id: 'a', status: 'ERROR' })];

    const { events } = computeSessionNotifications(prev, sessions, null);

    expect(events).toEqual([
      { kind: 'error', title: 'Session error', body: 'Session a', sessionId: 'a' },
    ]);
  });

  it('suppresses notifications for the active session', () => {
    const prev: PrevSessionMap = new Map([['a', { status: 'RUNNING' }]]);
    const sessions = [makeSession({ id: 'a', status: 'IDLE' })];

    const { events } = computeSessionNotifications(prev, sessions, 'a');

    expect(events).toEqual([]);
  });

  it('does not fire on the initial population of the list', () => {
    const prev: PrevSessionMap = new Map();
    const sessions = [makeSession({ id: 'a', status: 'ERROR' }), makeSession({ id: 'b', status: 'IDLE' })];

    const { events, nextMap } = computeSessionNotifications(prev, sessions, null);

    expect(events).toEqual([]);
    expect(nextMap.get('a')).toEqual({ status: 'ERROR' });
    expect(nextMap.get('b')).toEqual({ status: 'IDLE' });
  });

  it('does not duplicate-fire when status is unchanged across polls', () => {
    const prev: PrevSessionMap = new Map([['a', { status: 'IDLE' }]]);
    const sessions = [makeSession({ id: 'a', status: 'IDLE' })];

    const { events } = computeSessionNotifications(prev, sessions, null);

    expect(events).toEqual([]);
  });

  it('does not fire for a brand-new session appearing mid-poll (seeds without firing)', () => {
    const prev: PrevSessionMap = new Map([['a', { status: 'IDLE' }]]);
    const sessions = [
      makeSession({ id: 'a', status: 'IDLE' }),
      makeSession({ id: 'b', status: 'RUNNING' }),
    ];

    const { events, nextMap } = computeSessionNotifications(prev, sessions, null);

    expect(events).toEqual([]);
    expect(nextMap.get('b')).toEqual({ status: 'RUNNING' });
  });

  it('chains subsequent polls correctly using nextMap', () => {
    let prev: PrevSessionMap = new Map();
    const poll1 = [makeSession({ id: 'a', status: 'RUNNING' })];
    let result = computeSessionNotifications(prev, poll1, null);
    expect(result.events).toEqual([]);
    prev = result.nextMap;

    const poll2 = [makeSession({ id: 'a', status: 'IDLE' })];
    result = computeSessionNotifications(prev, poll2, null);
    expect(result.events).toEqual([
      { kind: 'finished', title: 'Session finished', body: 'Session a', sessionId: 'a' },
    ]);
    prev = result.nextMap;

    const poll3 = [makeSession({ id: 'a', status: 'IDLE' })];
    result = computeSessionNotifications(prev, poll3, null);
    expect(result.events).toEqual([]);
  });
});
