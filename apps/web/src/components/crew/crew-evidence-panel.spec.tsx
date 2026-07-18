import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CrewRunDetailDto } from '@nuncio/core/crew-api';
import { CrewEvidencePanel } from './crew-evidence-panel';

const head = 'a'.repeat(40);

function runWith(diffMetadata: Record<string, unknown>): CrewRunDetailDto {
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
});
