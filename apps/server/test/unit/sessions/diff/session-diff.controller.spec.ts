import { describe, expect, it } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { SessionDiffController } from '../../../../src/sessions/diff/session-diff.controller';
import type { SessionDiffService } from '../../../../src/sessions/diff/session-diff.service';
import type { DiffCommentInput } from '../../../../src/sessions/diff/session-diff.types';

/**
 * Diff controller contract (rung 3 sub-phase D). GET returns the structured diff;
 * POST validates the body then delegates the hunk comment to the service (which
 * builds the steer + rides the rung-1 path).
 */
describe('SessionDiffController', () => {
  function make(over: Partial<SessionDiffService> = {}) {
    const calls: Array<{ id: string; input: DiffCommentInput }> = [];
    const svc = {
      diff: over.diff ?? (async () => ({ files: [], truncated: false, omittedFiles: 0 })),
      comment: over.comment ?? (async (id: string, input: DiffCommentInput) => { calls.push({ id, input }); return { id, status: 'RUNNING' }; }),
    } as unknown as SessionDiffService;
    return { controller: new SessionDiffController(svc), calls };
  }

  it('GET returns the structured session diff', async () => {
    const { controller } = make({ diff: async () => ({ files: [{ path: 'a.ts', oldPath: null, status: 'modified', additions: 1, deletions: 0, hunks: [] }], truncated: false, omittedFiles: 0 }) });
    const out = await controller.get('s1');
    expect(out.files[0]!.path).toBe('a.ts');
  });

  it('POST comment delegates to the service with the parsed body', async () => {
    const { controller, calls } = make();
    await controller.comment('s1', {
      path: 'src/x.ts', startLine: 3, endLine: 5, hunk: '@@ ... @@', comment: 'use the helper',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe('s1');
    expect(calls[0]!.input.comment).toBe('use the helper');
  });

  it('POST rejects an empty comment (4xx)', () => {
    const { controller } = make();
    expect(() => controller.comment('s1', { path: 'src/x.ts', comment: '  ' })).toThrow(BadRequestException);
  });

  it('POST rejects a missing path (4xx)', () => {
    const { controller } = make();
    expect(() => controller.comment('s1', { comment: 'x' })).toThrow(BadRequestException);
  });
});
