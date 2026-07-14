import { describe, expect, it } from 'vitest';
import { timelineTargetFor } from './timeline-links';

describe('timelineTargetFor', () => {
  it('prefers sessionId over other targets', () => {
    expect(
      timelineTargetFor({
        sessionId: 's1',
        loopId: 'l1',
        attentionId: 'a1',
        prUrl: 'https://example.com/pr/1',
      }),
    ).toEqual({ to: '/session/s1' });
  });

  it('falls through to loop, attention, then PR url', () => {
    expect(
      timelineTargetFor({
        loopId: 'l1',
        attentionId: 'a1',
        prUrl: 'https://example.com/pr/1',
      }),
    ).toEqual({ to: '/autopilot/l1' });

    expect(
      timelineTargetFor({
        attentionId: 'a1',
        prUrl: 'https://example.com/pr/1',
      }),
    ).toEqual({ to: '/' });

    expect(
      timelineTargetFor({
        prUrl: 'https://example.com/pr/1',
      }),
    ).toEqual({ href: 'https://example.com/pr/1' });
  });

  it('returns null when nothing is set', () => {
    expect(timelineTargetFor({})).toBeNull();
  });
});
