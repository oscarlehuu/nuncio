import { apiFetch } from './http';

export interface TimelineEntryDto {
  id: string;
  ts: number;
  at: number;
  kind: string;
  title: string;
  projectPath: string | null;
  provider: string | null;
  sessionId?: string;
  taskId?: string;
  loopId?: string;
  attentionId?: string;
  prUrl?: string;
  outcome?: string;
  verify?: string;
  severity?: number;
}

export interface TimelineFeedDto {
  entries: TimelineEntryDto[];
  nextBefore: number | null;
}

export interface FetchTimelineOptions {
  from?: number;
  to?: number;
  before?: number;
  limit?: number;
}

export async function fetchTimeline(options: FetchTimelineOptions = {}): Promise<TimelineFeedDto> {
  const params = new URLSearchParams();
  if (typeof options.from === 'number') params.set('from', String(options.from));
  if (typeof options.to === 'number') params.set('to', String(options.to));
  if (typeof options.before === 'number') params.set('before', String(options.before));
  if (typeof options.limit === 'number') params.set('limit', String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch(`/api/timeline${query}`);
  if (!res.ok) throw new Error('Failed to load timeline');
  const data = (await res.json()) as Partial<TimelineFeedDto>;
  return {
    entries: Array.isArray(data.entries) ? data.entries : [],
    nextBefore: typeof data.nextBefore === 'number' ? data.nextBefore : null,
  };
}
