import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewArtifactDto } from '@nuncio/core/crew-api';
import { CrewArtifactViewer } from './crew-artifact-viewer';

const api = vi.hoisted(() => ({ fetchRange: vi.fn() }));
vi.mock('@nuncio/core/crew-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nuncio/core/crew-api')>()),
  fetchCrewArtifactRange: api.fetchRange,
}));

const artifact: CrewArtifactDto = {
  id: 'verify-1', runId: 'run-1', kind: 'verify-log', sha256: 'a'.repeat(64),
  byteCount: 10, retentionState: 'retained', createdAt: 1,
  metadata: {
    workspaceHead: 'head-1', passed: true, exitCode: 0, durationMs: 1,
    timedOut: false, outputOverflow: false, postBoundaryOk: true,
  },
};

describe('CrewArtifactViewer', () => {
  beforeEach(() => api.fetchRange.mockReset());

  it('loads bounded pages, trusts UTF-8 byte nextOffset, and reaches EOF', async () => {
    let resolveFirst!: (value: unknown) => void;
    api.fetchRange
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({
        artifactId: 'verify-1', offset: 6, nextOffset: 10, eof: true, text: 'done',
      });

    render(<CrewArtifactViewer runId="run-1" artifact={artifact} />);
    expect(screen.getByText('Loading evidence…')).toBeInTheDocument();
    await act(async () => resolveFirst({
      artifactId: 'verify-1', offset: 0, nextOffset: 6, eof: false, text: 'é🙂',
    }));

    expect(await screen.findByText('é🙂')).toBeInTheDocument();
    const loadMore = screen.getByRole('button', { name: 'Load more' });
    await act(async () => {
      loadMore.click();
      loadMore.click();
    });
    await waitFor(() => expect(screen.getByText(/é🙂done/)).toBeInTheDocument());
    expect(api.fetchRange).toHaveBeenCalledTimes(2);
    expect(api.fetchRange).toHaveBeenNthCalledWith(1, 'run-1', 'verify-1', {
      offset: 0, limit: 16_384,
    });
    expect(api.fetchRange).toHaveBeenNthCalledWith(2, 'run-1', 'verify-1', {
      offset: 6, limit: 16_384,
    });
    expect('é🙂').toHaveLength(3);
    expect(screen.getByText('Complete evidence loaded.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.queryByText(/storage|command|cwd|private/i)).toBeNull();
  });

  it('shows a retryable error without discarding already loaded text', async () => {
    api.fetchRange
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        artifactId: 'verify-1', offset: 0, nextOffset: 4, eof: true, text: 'safe',
      });

    render(<CrewArtifactViewer runId="run-1" artifact={artifact} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load evidence');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('safe')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Complete evidence loaded.')).toBeInTheDocument();
  });
});
