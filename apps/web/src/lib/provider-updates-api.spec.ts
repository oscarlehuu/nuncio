import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateProviderTool } from './provider-updates-api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('provider-updates-api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws the server message when a provider update request is rejected', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({ message: 'Codex does not support one-click updates.' }, false, 400),
    );

    await expect(updateProviderTool('codex')).rejects.toThrow(
      'Codex does not support one-click updates.',
    );
  });
});
