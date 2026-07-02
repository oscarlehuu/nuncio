// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { clearForgeCache, useForgeQuery } from './forge-cache';

describe('useForgeQuery', () => {
  beforeEach(() => {
    clearForgeCache();
  });

  it('starts null, then resolves with fetched data', async () => {
    const fetcher = vi.fn().mockResolvedValue(['a']);
    const { result } = renderHook(() => useForgeQuery('k1', fetcher));

    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.data).toEqual(['a']));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serves cached data instantly on remount without refetching while fresh', async () => {
    const fetcher = vi.fn().mockResolvedValue(['a']);
    const first = renderHook(() => useForgeQuery('k2', fetcher));
    await waitFor(() => expect(first.result.current.data).toEqual(['a']));
    first.unmount();

    const second = renderHook(() => useForgeQuery('k2', fetcher));
    // Cached value visible synchronously — the "instant tab switch".
    expect(second.result.current.data).toEqual(['a']);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  });

  it('revalidates stale entries in the background and updates subscribers', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(['old']).mockResolvedValueOnce(['new']);
    const first = renderHook(() => useForgeQuery('k3', fetcher, { staleMs: 0 }));
    await waitFor(() => expect(first.result.current.data).toEqual(['old']));
    first.unmount();

    const second = renderHook(() => useForgeQuery('k3', fetcher, { staleMs: 0 }));
    expect(second.result.current.data).toEqual(['old']); // stale shown immediately
    await waitFor(() => expect(second.result.current.data).toEqual(['new']));
  });

  it('keeps the previous reference when the payload is unchanged', async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: 1 }]);
    const { result } = renderHook(() => useForgeQuery('k4', fetcher, { staleMs: 0 }));
    await waitFor(() => expect(result.current.data).toEqual([{ id: 1 }]));
    const before = result.current.data;

    await act(() => result.current.refresh());
    expect(result.current.data).toBe(before);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent fetches for the same key', async () => {
    let resolve!: (value: string[]) => void;
    const fetcher = vi.fn().mockImplementation(
      () => new Promise<string[]>((r) => (resolve = r)),
    );
    const a = renderHook(() => useForgeQuery('k5', fetcher));
    const b = renderHook(() => useForgeQuery('k5', fetcher));

    resolve(['shared']);
    await waitFor(() => expect(a.result.current.data).toEqual(['shared']));
    await waitFor(() => expect(b.result.current.data).toEqual(['shared']));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports an initial-load failure via onError and leaves data null', async () => {
    const onError = vi.fn();
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useForgeQuery('k6', fetcher, { onError }));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(result.current.data).toBeNull();
  });

  it('refresh() propagates mutation-time failures to the caller', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(['ok']).mockRejectedValueOnce(new Error('nope'));
    const { result } = renderHook(() => useForgeQuery('k7', fetcher));
    await waitFor(() => expect(result.current.data).toEqual(['ok']));

    await expect(result.current.refresh()).rejects.toThrow('nope');
    expect(result.current.data).toEqual(['ok']); // stale data survives the failure
  });

  it('clearForgeCache(prefix) drops matching keys only', async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    const a = renderHook(() => useForgeQuery('pulls:/repo:open', fetcher));
    const b = renderHook(() => useForgeQuery('issues:/repo:open', fetcher));
    await waitFor(() => expect(a.result.current.data).toBe(1));
    await waitFor(() => expect(b.result.current.data).toBe(1));
    a.unmount();
    b.unmount();

    clearForgeCache('pulls:');
    const again = renderHook(() => useForgeQuery('issues:/repo:open', fetcher));
    expect(again.result.current.data).toBe(1);
    const cleared = renderHook(() => useForgeQuery('pulls:/repo:open', vi.fn().mockResolvedValue(2)));
    expect(cleared.result.current.data).toBeNull();
  });
});
