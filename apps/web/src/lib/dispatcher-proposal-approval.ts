import { useSyncExternalStore } from 'react';
import { approveDispatcherProposal } from './api';

type ApprovalResult = Awaited<ReturnType<typeof approveDispatcherProposal>>;
type SharedOutcome =
  | { ok: true; result: ApprovalResult }
  | { ok: false; error: unknown };

export type ApprovalOutcome =
  | { owner: boolean; ok: true; result: ApprovalResult }
  | { owner: boolean; ok: false; error: unknown };

interface ApprovalEntry {
  request: Promise<SharedOutcome>;
  consumers: Set<Promise<void>>;
  settled: boolean;
}

const inFlight = new Map<string, ApprovalEntry>();
const listeners = new Set<() => void>();
let busySnapshot = new Set<string>();

function publish(): void {
  busySnapshot = new Set(inFlight.keys());
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Set<string> {
  return busySnapshot;
}

function releaseIfFinished(id: string, entry: ApprovalEntry): void {
  if (!entry.settled || entry.consumers.size > 0 || inFlight.get(id) !== entry) return;
  inFlight.delete(id);
  publish();
}

/**
 * Shared across mounted surfaces so one proposal produces one request and toast
 * owner. Busy remains true until every caller finishes its optimistic update and
 * post-settlement refresh.
 */
export function approveDispatcherProposalOnce(
  id: string,
  afterSettled: (outcome: ApprovalOutcome) => void | Promise<void>,
): Promise<void> {
  let entry = inFlight.get(id);
  const owner = !entry;
  if (!entry) {
    const request: Promise<SharedOutcome> = approveDispatcherProposal(id).then(
      (result) => ({ ok: true, result }),
      (error: unknown) => ({ ok: false, error }),
    );
    entry = { request, consumers: new Set(), settled: false };
    inFlight.set(id, entry);
    publish();
    void request.finally(() => {
      entry!.settled = true;
      releaseIfFinished(id, entry!);
    });
  }

  const consumer = entry.request.then((outcome) =>
    afterSettled({ ...outcome, owner }),
  );
  entry.consumers.add(consumer);
  const release = () => {
    entry!.consumers.delete(consumer);
    releaseIfFinished(id, entry!);
  };
  void consumer.then(release, release);
  return consumer;
}

export function useDispatcherProposalBusyIds(): Set<string> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
