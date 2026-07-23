import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    approveDispatcherProposal: vi.fn(),
  };
});

import { approveDispatcherProposal } from './api';
import {
  approveDispatcherProposalOnce,
  useDispatcherProposalBusyIds,
} from './dispatcher-proposal-approval';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('approveDispatcherProposalOnce', () => {
  beforeEach(() => {
    vi.mocked(approveDispatcherProposal).mockReset();
  });

  afterEach(async () => {
    // Drain any leftover in-flight entries so module state does not leak.
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('coalesces concurrent callers into one request with a single toast owner', async () => {
    const approval = deferred<{ proposalId: string; taskIds: string[] }>();
    vi.mocked(approveDispatcherProposal).mockReturnValue(approval.promise);

    const outcomes: Array<{ owner: boolean; ok: boolean }> = [];
    const first = approveDispatcherProposalOnce('shared-1', async (outcome) => {
      outcomes.push({ owner: outcome.owner, ok: outcome.ok });
    });
    const second = approveDispatcherProposalOnce('shared-1', async (outcome) => {
      outcomes.push({ owner: outcome.owner, ok: outcome.ok });
    });

    expect(approveDispatcherProposal).toHaveBeenCalledTimes(1);
    expect(approveDispatcherProposal).toHaveBeenCalledWith('shared-1');

    approval.resolve({ proposalId: 'shared-1', taskIds: ['t1'] });
    await Promise.all([first, second]);

    expect(outcomes).toEqual([
      { owner: true, ok: true },
      { owner: false, ok: true },
    ]);
  });

  it('keeps the busy set until every consumer finishes afterSettled work', async () => {
    const approval = deferred<{ proposalId: string; taskIds: string[] }>();
    const refresh = deferred<void>();
    vi.mocked(approveDispatcherProposal).mockReturnValue(approval.promise);

    const { result } = renderHook(() => useDispatcherProposalBusyIds());
    expect(result.current.has('busy-1')).toBe(false);

    const consumer = approveDispatcherProposalOnce('busy-1', async () => {
      await refresh.promise;
    });

    await waitFor(() => expect(result.current.has('busy-1')).toBe(true));

    approval.resolve({ proposalId: 'busy-1', taskIds: [] });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.has('busy-1')).toBe(true);

    refresh.resolve();
    await consumer;
    await waitFor(() => expect(result.current.has('busy-1')).toBe(false));
  });

  it('propagates approval failures to every consumer without leaving a stuck busy id', async () => {
    const approval = deferred<{ proposalId: string; taskIds: string[] }>();
    vi.mocked(approveDispatcherProposal).mockReturnValue(approval.promise);

    const { result } = renderHook(() => useDispatcherProposalBusyIds());
    const outcomes: Array<{ owner: boolean; ok: boolean; error?: unknown }> = [];

    const first = approveDispatcherProposalOnce('fail-1', async (outcome) => {
      outcomes.push(
        outcome.ok
          ? { owner: outcome.owner, ok: true }
          : { owner: outcome.owner, ok: false, error: outcome.error },
      );
    });
    const second = approveDispatcherProposalOnce('fail-1', async (outcome) => {
      outcomes.push(
        outcome.ok
          ? { owner: outcome.owner, ok: true }
          : { owner: outcome.owner, ok: false, error: outcome.error },
      );
    });

    await waitFor(() => expect(result.current.has('fail-1')).toBe(true));
    approval.reject(new Error('Dispatcher offline'));
    await Promise.all([first, second]);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.ok === false)).toBe(true);
    expect(outcomes[0]).toMatchObject({ owner: true, ok: false });
    expect(outcomes[1]).toMatchObject({ owner: false, ok: false });
    expect((outcomes[0] as { error: Error }).error).toEqual(new Error('Dispatcher offline'));
    await waitFor(() => expect(result.current.has('fail-1')).toBe(false));
  });

  it('starts a fresh request after a prior approval fully settles', async () => {
    vi.mocked(approveDispatcherProposal)
      .mockResolvedValueOnce({ proposalId: 'seq-1', taskIds: ['a'] })
      .mockResolvedValueOnce({ proposalId: 'seq-1', taskIds: ['b'] });

    await approveDispatcherProposalOnce('seq-1', async () => undefined);
    await approveDispatcherProposalOnce('seq-1', async () => undefined);

    expect(approveDispatcherProposal).toHaveBeenCalledTimes(2);
  });
});
