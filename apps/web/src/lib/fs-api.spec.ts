import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchDirectories, type DirListing, type DirEntry } from './fs-api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

function makeEntry(over: Partial<DirEntry> = {}): DirEntry {
  return { name: 'alpha', path: '/x/alpha', isGit: false, ...over };
}

function makeListing(over: Partial<DirListing> = {}): DirListing {
  return { current: '/x', parent: '/', entries: [makeEntry()], ...over };
}

describe('fs-api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchDirectories with no arg GETs /api/fs/dirs', async () => {
    fetchMock.mockResolvedValue(jsonRes(makeListing()));
    await fetchDirectories();
    expect(fetchMock).toHaveBeenCalledWith('/api/fs/dirs');
  });

  it('fetchDirectories encodes the path query parameter', async () => {
    fetchMock.mockResolvedValue(jsonRes(makeListing({ current: '/Users/x/code' })));
    await fetchDirectories('/Users/x/code');
    expect(fetchMock).toHaveBeenCalledWith('/api/fs/dirs?path=' + encodeURIComponent('/Users/x/code'));
  });

  it('returns the parsed listing', async () => {
    const listing = makeListing({
      current: '/Users/x',
      parent: '/Users',
      entries: [makeEntry({ name: 'beta', path: '/Users/x/beta', isGit: true })],
    });
    fetchMock.mockResolvedValue(jsonRes(listing));
    expect(await fetchDirectories('/Users/x')).toEqual(listing);
  });

  it('throws with the HTTP status when the response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonRes({ message: 'Not a directory: /nope' }, false, 400));
    await expect(fetchDirectories('/nope')).rejects.toThrow('Failed to load directories (HTTP 400: Not a directory: /nope)');
  });

  it('throws a 404-specific hint when the route is missing', async () => {
    fetchMock.mockResolvedValue(jsonRes({ message: 'Not found' }, false, 404));
    await expect(fetchDirectories()).rejects.toThrow(/404.*restart the backend/);
  });

  it('throws a network hint when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await expect(fetchDirectories()).rejects.toThrow(/network.*backend running/);
  });
});
