import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CrewRunDetailDto } from '@nuncio/core/crew-api';
import { CrewEvidencePanel } from './crew-evidence-panel';

vi.mock('./crew-artifact-viewer', () => ({
  CrewArtifactViewer: ({ artifact, onClose }: { artifact: { id: string }; onClose?: () => void }) => (
    <div>
      <span>{`viewer:${artifact.id}`}</span>
      <button onClick={onClose}>Close viewer</button>
    </div>
  ),
}));

const head = 'a'.repeat(40);

function runWith(diffMetadata: Record<string, unknown>, over: Record<string, unknown> = {}): CrewRunDetailDto {
  return {
    id: 'run-1', taskId: 'task-1', phase: 'REVIEW', status: 'RUNNING', outcome: null,
    revision: 3, contextRevision: 2, projectPath: '/repo', workspaceHead: head,
    profileSnapshot: { bindings: {}, policy: {} },
    maxVerifyRetries: 2, maxReviewRetries: 2,
    members: [], results: [],
    gates: [{ kind: 'review', status: 'running', workspaceHead: head, warnings: [], artifactId: null }],
    artifacts: [{
      id: 'diff-1', runId: 'run-1', kind: 'workspace-diff', sha256: 'b'.repeat(64),
      byteCount: 10, retentionState: 'retained', createdAt: 2,
      metadata: { workspaceHead: head, baseHead: 'c'.repeat(40), truncated: false, ...diffMetadata },
    }],
    ...over,
  } as unknown as CrewRunDetailDto;
}

describe('CrewEvidencePanel', () => {
  it('badges a UI-touching current diff with its file count', () => {
    render(<CrewEvidencePanel run={runWith({ uiTouched: true, uiFileCount: 3 })} />);
    expect(screen.getByText('UI-touching diff · 3 files')).toBeInTheDocument();
  });

  it('uses the singular form for one file', () => {
    render(<CrewEvidencePanel run={runWith({ uiTouched: true, uiFileCount: 1 })} />);
    expect(screen.getByText('UI-touching diff · 1 file')).toBeInTheDocument();
  });

  it('shows no badge when the diff is not UI-touching or unclassified', () => {
    const { rerender } = render(<CrewEvidencePanel run={runWith({ uiTouched: false, uiFileCount: 0 })} />);
    expect(screen.queryByText(/UI-touching diff/)).toBeNull();
    rerender(<CrewEvidencePanel run={runWith({})} />);
    expect(screen.queryByText(/UI-touching diff/)).toBeNull();
  });

  it('opens the selected artifact in the viewer and closes it again', async () => {
    const user = userEvent.setup();
    render(<CrewEvidencePanel run={runWith({ uiTouched: true, uiFileCount: 2 })} />);
    expect(screen.queryByText('viewer:diff-1')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open workspace diff' }));
    expect(screen.getByText('viewer:diff-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close viewer' }));
    expect(screen.queryByText('viewer:diff-1')).toBeNull();
  });

  it('surfaces the latest current-head blocking review finding', () => {
    const run = runWith({}, {
      gates: [{ kind: 'review', status: 'failed', workspaceHead: head, warnings: [], artifactId: null }],
      results: [{
        id: 'result-1', runId: 'run-1', memberSessionId: 'member-1', createdAt: 3, workspaceHead: head,
        result: {
          kind: 'review', summary: 'Blocked', workspaceHead: head,
          findings: [{ severity: 'blocker', title: 'Broken layout', body: 'Header overlaps the composer.' }],
        },
      }],
    });
    render(<CrewEvidencePanel run={run} />);
    expect(screen.getByText('Broken layout')).toBeInTheDocument();
    expect(screen.getByText('Header overlaps the composer.')).toBeInTheDocument();
  });

  it('renders nothing when there is no current evidence and no blocker', () => {
    const { container } = render(<CrewEvidencePanel run={runWith({}, { artifacts: [], gates: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
