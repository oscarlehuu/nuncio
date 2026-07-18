import { CrewRunQueryService } from '../../../src/crew/crew-run-query.service';

describe('CrewRunQueryService', () => {
  it('returns only public artifact metadata and delegates bounded run-scoped reads', () => {
    const verifyCommand = `TOKEN=${'s'.repeat(40)} bun test`;
    const run = {
      id: 'run-1', verifyRetriesUsed: 0, reviewRetriesUsed: 0,
      verifyExtraRounds: 0, reviewExtraRounds: 0,
      profileSnapshot: { policy: { maxVerifyRetries: 2, maxReviewRetries: 2, verifyCommand } },
    };
    const readRange = jest.fn(() => ({
      artifactId: 'artifact-1', offset: 2, nextOffset: 6, eof: false, text: '[REDACTED]',
    }));
    const service = new CrewRunQueryService(
      { findById: () => run } as never, { list: () => [] } as never,
      { listByRun: () => [] } as never, { listByRun: () => [] } as never,
      { listByRun: () => [{
        id: 'artifact-1', kind: 'verify-log', relativeStoragePath: 'private/path',
        metadata: { workspaceHead: 'head', passed: false, command: 'secret', cwd: '/private' },
      }, {
        id: 'artifact-2', kind: 'workspace-diff', relativeStoragePath: 'private/diff',
        metadata: {
          workspaceHead: 'head', baseHead: 'base', truncated: false,
          uiTouched: true, uiFiles: ['/worktree/src/button.tsx'], uiFileCount: 1,
        },
      }] } as never,
      { items: () => [] } as never, { readRange } as never,
    );
    const detail = service.detail('run-1');
    expect(JSON.stringify(detail.artifacts)).not.toContain('relativeStoragePath');
    expect(JSON.stringify(detail.artifacts)).not.toContain('command');
    expect(JSON.stringify(detail.run)).not.toContain(verifyCommand);
    expect(detail.run.profileSnapshot.policy.verifyCommand).toBeNull();
    const diffArtifact = detail.artifacts.find((artifact) => artifact.kind === 'workspace-diff');
    expect(diffArtifact?.metadata).toMatchObject({ uiTouched: true, uiFileCount: 1 });
    expect(JSON.stringify(diffArtifact)).not.toContain('uiFiles');
    expect(service.readArtifactRange('run-1', 'artifact-1', 2, 4)).toMatchObject({ text: '[REDACTED]' });
    expect(readRange).toHaveBeenCalledWith('run-1', 'artifact-1', 2, 4);
  });
});
