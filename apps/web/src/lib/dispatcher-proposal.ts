import type { AttentionItemDto } from './api';

interface DispatcherProposal {
  title: string;
  projectPath: string | null;
  rationale: string;
}

export interface DispatcherPayload {
  proposals: DispatcherProposal[];
  approvedAt: number | null;
  taskIds: string[];
}

export function dispatcherPayload(item: AttentionItemDto): DispatcherPayload {
  const raw = item.payload ?? {};
  const proposals = Array.isArray(raw.proposals)
    ? raw.proposals.flatMap((proposal): DispatcherProposal[] => {
        if (!proposal || typeof proposal !== 'object') return [];
        const value = proposal as Record<string, unknown>;
        if (typeof value.title !== 'string') return [];
        return [{
          title: value.title,
          projectPath: typeof value.projectPath === 'string' ? value.projectPath : null,
          rationale: typeof value.rationale === 'string' ? value.rationale : '',
        }];
      })
    : [];

  return {
    proposals,
    approvedAt: typeof raw.approvedAt === 'number' ? raw.approvedAt : null,
    taskIds: Array.isArray(raw.taskIds)
      ? raw.taskIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

export function dispatcherDone(payload: DispatcherPayload): boolean {
  return payload.approvedAt !== null || payload.taskIds.length > 0;
}

export function queuedTasksLabel(taskCount: number): string {
  return `${taskCount} task${taskCount === 1 ? '' : 's'} queued`;
}

function newest(items: AttentionItemDto[]): AttentionItemDto | null {
  return items.reduce<AttentionItemDto | null>((current, item) => {
    if (!current) return item;
    if (item.createdAt !== current.createdAt) {
      return item.createdAt > current.createdAt ? item : current;
    }
    if (item.updatedAt !== current.updatedAt) {
      return item.updatedAt > current.updatedAt ? item : current;
    }
    return item.id > current.id ? item : current;
  }, null);
}

/**
 * Tonight always surfaces the newest actionable draft. An approved row is only
 * a fallback for the interrupted-after-audit case where it remains open.
 */
export function selectTonightDispatcherProposal(
  items: AttentionItemDto[],
): AttentionItemDto | null {
  const proposals = items.filter(
    (item) =>
      item.status === 'open' &&
      item.kind === 'dispatcher-proposal' &&
      dispatcherPayload(item).proposals.length > 0,
  );
  const actionable = proposals.filter((item) => !dispatcherDone(dispatcherPayload(item)));
  return newest(actionable) ?? newest(proposals);
}

export function markDispatcherProposalApproved(
  item: AttentionItemDto,
  taskIds: string[],
): AttentionItemDto {
  return {
    ...item,
    payload: {
      ...item.payload,
      approvedAt: Date.now(),
      taskIds,
    },
  };
}
