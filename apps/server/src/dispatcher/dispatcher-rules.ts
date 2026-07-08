import { basename } from 'node:path';
import { rankAttentionItems } from '../attention/attention-ranking';
import type { AttentionItemDto } from '../attention/attention.types';
import type { LoopDto, LoopRunDto } from '../loops/loops.types';
import type { SessionDto, SessionEvent } from '../sessions/domain/sessions.types';
import type { TaskDto } from '../tasks/tasks.types';

export const DISPATCHER_KIND = 'dispatcher-proposal';
export const DISPATCHER_SEVERITY = 2;
export const DEFAULT_DISPATCHER_PROPOSAL_LIMIT = 5;

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const STALE_PR_MS = DAY_MS;
const QUEUED_STARVATION_MS = 2 * HOUR_MS;
const RUNNING_STARVATION_MS = 4 * HOUR_MS;

export interface DispatcherProjectDefaults {
  engine?: string | null;
  model?: string | null;
}

export interface DispatcherProposal {
  subjectKey: string;
  title: string;
  prompt: string;
  projectPath: string | null;
  engine?: string;
  model?: string;
  rationale: string;
}

export interface DispatcherRuleSources {
  attentionItems: AttentionItemDto[];
  loops: LoopDto[];
  loopRuns: LoopRunDto[];
  sessions: SessionDto[];
  eventsBySession: Record<string, SessionEvent[]>;
  tasks: TaskDto[];
  projectDefaults: Record<string, DispatcherProjectDefaults>;
  projectWeights: Record<string, number>;
  now: number;
  limit?: number;
}

interface Candidate {
  proposal: DispatcherProposal;
  severity: number;
  projectWeight: number;
  sourceAt: number;
}

export function foldDispatcherProposals(sources: DispatcherRuleSources): DispatcherProposal[] {
  const existingSubjects = existingDispatcherSubjects(
    sources.attentionItems,
    dispatcherSubjectFor(sources.now),
  );
  const inFlight = inFlightTaskKeys(sources.tasks);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  const add = (candidate: Candidate): void => {
    const key = candidate.proposal.subjectKey;
    if (seen.has(key) || existingSubjects.has(key)) return;
    if (inFlight.has(taskKey(candidate.proposal.prompt, candidate.proposal.projectPath))) return;
    if (inFlight.has(taskKey(candidate.proposal.title, candidate.proposal.projectPath))) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const item of sources.attentionItems) {
    if (item.status !== 'open' || item.acknowledgedAt !== null) continue;
    if (item.kind === DISPATCHER_KIND) continue;
    if (item.kind === 'verify-dead') {
      add(candidateFromVerifyAttention(item, sources));
    } else if (item.kind === 'tripped-breaker') {
      add(candidateFromBrokenLoopAttention(item, sources));
    } else if (item.kind === 'pr-review' && sources.now - item.createdAt > STALE_PR_MS) {
      add(candidateFromStalePr(item, sources));
    } else if (!['pr-review', 'tripped-breaker'].includes(item.kind)) {
      add(candidateFromGenericAttention(item, sources));
    }
  }

  for (const loop of sources.loops) {
    if (loop.status === 'broken') add(candidateFromBrokenLoop(loop, sources));
  }

  for (const session of sources.sessions) {
    if (hasUnclearedVerifyNeedsAttention(sources.eventsBySession[session.id] ?? [])) {
      add(candidateFromVerifySession(session, sources));
    }
  }

  for (const candidate of candidatesFromYesterdayFailedLoops(sources)) add(candidate);
  for (const task of sources.tasks) {
    if (task.status === 'FAILED' && task.finishedAt !== null && isYesterday(task.finishedAt, sources.now)) {
      add(candidateFromFailedTask(task, sources));
    }
    if (task.status === 'QUEUED' && sources.now - task.createdAt > QUEUED_STARVATION_MS) {
      add(candidateFromQueuedStarvation(task, sources));
    }
    if (task.status === 'RUNNING' && task.startedAt !== null && sources.now - task.startedAt > RUNNING_STARVATION_MS) {
      add(candidateFromRunningStarvation(task, sources));
    }
  }

  return candidates
    .sort((a, b) => {
      if (a.severity !== b.severity) return b.severity - a.severity;
      if (a.projectWeight !== b.projectWeight) return b.projectWeight - a.projectWeight;
      if (a.sourceAt !== b.sourceAt) return a.sourceAt - b.sourceAt;
      return a.proposal.subjectKey < b.proposal.subjectKey ? -1 : 1;
    })
    .slice(0, sources.limit ?? DEFAULT_DISPATCHER_PROPOSAL_LIMIT)
    .map((candidate) => candidate.proposal);
}

export function dispatcherSubjectFor(now: number): string {
  return `dispatch:${localDay(now)}`;
}

function candidateFromGenericAttention(item: AttentionItemDto, sources: DispatcherRuleSources): Candidate {
  return withDefaults(
    {
      subjectKey: `attention:${item.kind}:${item.subjectId}`,
      title: `Handle ${item.title}`,
      prompt: `Handle this Nuncio attention item: ${item.title}. Rationale: source: open ${item.kind} attention item ${item.subjectId}.`,
      projectPath: item.projectPath,
      rationale: `source: open ${item.kind} attention item ${item.subjectId}`,
    },
    item.severity,
    item.createdAt,
    sources,
  );
}

function candidateFromVerifyAttention(item: AttentionItemDto, sources: DispatcherRuleSources): Candidate {
  const project = projectLabel(item.projectPath);
  return withDefaults(
    {
      subjectKey: `session:verify-dead:${item.subjectId}`,
      title: `Fix the failing verify in ${project}`,
      prompt: `Fix the failing verify in ${project}. Inspect session ${item.subjectId}, reproduce the failure, and land the smallest verified fix.`,
      projectPath: item.projectPath,
      rationale: `source: open verify-dead attention item ${item.subjectId}`,
    },
    5,
    item.createdAt,
    sources,
  );
}

function candidateFromBrokenLoopAttention(item: AttentionItemDto, sources: DispatcherRuleSources): Candidate {
  const loop = sources.loops.find((entry) => entry.id === item.subjectId);
  return loop ? candidateFromBrokenLoop(loop, sources) : withDefaults(
    {
      subjectKey: `attention:tripped-breaker:${item.subjectId}`,
      title: `Resume or investigate ${item.title}`,
      prompt: `Resume or investigate the broken loop behind attention item ${item.subjectId}.`,
      projectPath: item.projectPath,
      rationale: `source: open tripped-breaker attention item ${item.subjectId}`,
    },
    4,
    item.createdAt,
    sources,
  );
}

function candidateFromBrokenLoop(loop: LoopDto, sources: DispatcherRuleSources): Candidate {
  const name = loop.name ?? loop.goal;
  return withDefaults(
    {
      subjectKey: `loop:broken:${loop.id}`,
      title: `Resume or investigate ${name}`,
      prompt: `Resume or investigate loop "${name}". Find why it is broken, fix the blocker, and resume only if the loop is safe to run.`,
      projectPath: loop.projectPath,
      ...(loop.engine ? { engine: loop.engine } : {}),
      ...(loop.model ? { model: loop.model } : {}),
      rationale: `source: loop ${loop.id} is broken`,
    },
    4,
    loop.updatedAt,
    sources,
  );
}

function candidateFromStalePr(item: AttentionItemDto, sources: DispatcherRuleSources): Candidate {
  const payload = item.payload ?? {};
  const number = typeof payload.number === 'number' || typeof payload.number === 'string'
    ? String(payload.number)
    : item.subjectId.split('#').at(-1) ?? item.subjectId;
  return withDefaults(
    {
      subjectKey: `attention:pr-review:${item.subjectId}`,
      title: `Review or merge PR #${number}`,
      prompt: `Review or merge PR #${number}. Check the diff, verify status, and either merge it or leave concrete blocking feedback.`,
      projectPath: item.projectPath,
      rationale: `source: pr-review item ${item.subjectId} open for more than 24h`,
    },
    2,
    item.createdAt,
    sources,
  );
}

function candidateFromVerifySession(session: SessionDto, sources: DispatcherRuleSources): Candidate {
  const project = projectLabel(session.projectPath);
  return withDefaults(
    {
      subjectKey: `session:verify-dead:${session.id}`,
      title: `Fix the failing verify in ${project}`,
      prompt: `Fix the failing verify in ${project}. Inspect session ${session.id}, reproduce the failed verify, and land the smallest verified fix.`,
      projectPath: session.projectPath,
      ...(session.provider ? { engine: session.provider } : {}),
      ...(session.model ? { model: session.model } : {}),
      rationale: `source: session ${session.id} has verify_needs_attention`,
    },
    5,
    lastEventAt(sources.eventsBySession[session.id] ?? []) ?? session.updatedAt,
    sources,
  );
}

function candidatesFromYesterdayFailedLoops(sources: DispatcherRuleSources): Candidate[] {
  const yesterday = localDay(sources.now - DAY_MS);
  return sources.loops.flatMap((loop) => {
    if (loop.status === 'broken') return [];
    const runs = sources.loopRuns.filter((run) => run.loopId === loop.id && run.dayBucket === yesterday);
    const settled = runs.filter((run) => run.outcome === 'ok' || run.outcome === 'failed');
    if (settled.length === 0 || settled.some((run) => run.outcome === 'ok')) return [];
    const name = loop.name ?? loop.goal;
    return [withDefaults(
      {
        subjectKey: `loop:yesterday-failed:${loop.id}:${yesterday}`,
        title: `Investigate why ${name} failed ${settled.length} times`,
        prompt: `Investigate why loop "${name}" failed ${settled.length} times yesterday. Compare the run history, identify the shared blocker, and queue the smallest fix.`,
        projectPath: loop.projectPath,
        ...(loop.engine ? { engine: loop.engine } : {}),
        ...(loop.model ? { model: loop.model } : {}),
        rationale: `source: yesterday loop ${loop.id} had ${settled.length} failed runs and 0 ok runs`,
      },
      3,
      settled[0]!.createdAt,
      sources,
    )];
  });
}

function candidateFromFailedTask(task: TaskDto, sources: DispatcherRuleSources): Candidate {
  return withDefaults(
    {
      subjectKey: `task:yesterday-failed:${task.id}`,
      title: `Investigate failed task: ${shortText(task.prompt)}`,
      prompt: `Investigate failed task "${shortText(task.prompt)}". Read its session/output, identify why it failed, and queue a focused fix.`,
      projectPath: task.projectPath,
      ...(task.provider ? { engine: task.provider } : {}),
      ...(task.model ? { model: task.model } : {}),
      rationale: `source: yesterday failed task ${task.id}`,
    },
    3,
    task.finishedAt ?? task.updatedAt,
    sources,
  );
}

function candidateFromQueuedStarvation(task: TaskDto, sources: DispatcherRuleSources): Candidate {
  return withDefaults(
    {
      subjectKey: `task-starvation:${task.id}`,
      title: `Unblock queued task: ${shortText(task.prompt)}`,
      prompt: `Unblock queued task "${shortText(task.prompt)}". Check why it has not started and clear the queue or adjust concurrency.`,
      projectPath: task.projectPath,
      ...(task.provider ? { engine: task.provider } : {}),
      ...(task.model ? { model: task.model } : {}),
      rationale: `source: queued task ${task.id} older than 2h`,
    },
    2,
    task.createdAt,
    sources,
  );
}

function candidateFromRunningStarvation(task: TaskDto, sources: DispatcherRuleSources): Candidate {
  return withDefaults(
    {
      subjectKey: `task-starvation:${task.id}`,
      title: `Check running task: ${shortText(task.prompt)}`,
      prompt: `Check running task "${shortText(task.prompt)}". Inspect the linked session and decide whether to steer, pause, or retry.`,
      projectPath: task.projectPath,
      ...(task.provider ? { engine: task.provider } : {}),
      ...(task.model ? { model: task.model } : {}),
      rationale: `source: running task ${task.id} older than 4h`,
    },
    2,
    task.startedAt ?? task.updatedAt,
    sources,
  );
}

function withDefaults(
  proposal: DispatcherProposal,
  severity: number,
  sourceAt: number,
  sources: DispatcherRuleSources,
): Candidate {
  const defaults = proposal.projectPath ? sources.projectDefaults[proposal.projectPath] : undefined;
  const withProjectDefaults = {
    ...proposal,
    ...(proposal.engine || !defaults?.engine ? {} : { engine: defaults.engine }),
    ...(proposal.model || !defaults?.model ? {} : { model: defaults.model }),
  };
  return {
    proposal: withProjectDefaults,
    severity,
    projectWeight: proposal.projectPath ? sources.projectWeights[proposal.projectPath] ?? 1 : 1,
    sourceAt,
  };
}

function hasUnclearedVerifyNeedsAttention(events: SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (event.type === 'verify_result' && (event.payload as { ok?: boolean }).ok === true) return false;
    if (event.type === 'verify_needs_attention') return true;
  }
  return false;
}

function lastEventAt(events: SessionEvent[]): number | null {
  return events.length ? events[events.length - 1]!.createdAt : null;
}

function existingDispatcherSubjects(items: AttentionItemDto[], currentSubjectId: string): Set<string> {
  const subjects = new Set<string>();
  for (const item of items) {
    if (item.status !== 'open' || item.kind !== DISPATCHER_KIND) continue;
    if (item.subjectId === currentSubjectId) continue;
    const proposals = proposalsFromPayload(item.payload);
    for (const proposal of proposals) {
      subjects.add(proposal.subjectKey);
      for (const alias of canonicalSubjectAliases(proposal.subjectKey)) subjects.add(alias);
    }
  }
  return subjects;
}

function canonicalSubjectAliases(subjectKey: string): string[] {
  if (subjectKey.startsWith('attention:verify-dead:')) {
    return [`session:verify-dead:${subjectKey.slice('attention:verify-dead:'.length)}`];
  }
  if (subjectKey.startsWith('attention:tripped-breaker:')) {
    return [`loop:broken:${subjectKey.slice('attention:tripped-breaker:'.length)}`];
  }
  return [];
}

function proposalsFromPayload(payload: Record<string, unknown> | null): Array<{ subjectKey: string }> {
  const proposals = payload?.proposals;
  if (!Array.isArray(proposals)) return [];
  return proposals.filter((proposal): proposal is { subjectKey: string } =>
    typeof proposal === 'object' && proposal !== null && typeof (proposal as { subjectKey?: unknown }).subjectKey === 'string',
  );
}

function inFlightTaskKeys(tasks: TaskDto[]): Set<string> {
  const keys = new Set<string>();
  for (const task of tasks) {
    if (task.status !== 'QUEUED' && task.status !== 'RUNNING') continue;
    keys.add(taskKey(task.prompt, task.projectPath));
  }
  return keys;
}

function taskKey(text: string, projectPath: string | null): string {
  return `${projectPath ?? ''}\n${text.trim()}`;
}

function isYesterday(value: number, now: number): boolean {
  return localDay(value) === localDay(now - DAY_MS);
}

function localDay(value: number): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function projectLabel(projectPath: string | null): string {
  return projectPath ? basename(projectPath) || projectPath : 'unassigned';
}

function shortText(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > 80 ? `${single.slice(0, 77)}...` : single;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function rankDispatcherAttention(items: AttentionItemDto[], projectWeights: Record<string, number>): AttentionItemDto[] {
  return rankAttentionItems(items, projectWeights);
}
