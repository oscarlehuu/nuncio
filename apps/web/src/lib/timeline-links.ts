import type { DigestHighlight, TimelineEntryDto } from './api';
import type { OpenTarget } from './attention-kind';

type TimelineLike = Pick<
  DigestHighlight | TimelineEntryDto,
  'sessionId' | 'loopId' | 'attentionId' | 'prUrl'
>;

export function timelineTargetFor(entry: TimelineLike): OpenTarget | null {
  if (entry.sessionId) return { to: `/session/${entry.sessionId}` };
  if (entry.loopId) return { to: `/autopilot/${entry.loopId}` };
  if (entry.attentionId) return { to: '/' };
  if (entry.prUrl) return { href: entry.prUrl };
  return null;
}
