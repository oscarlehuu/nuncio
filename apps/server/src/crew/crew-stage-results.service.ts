import { Injectable } from '@nestjs/common';
import { CrewGateEvidenceService } from './crew-gate-evidence.service';
import type { CrewSubmissionNotice } from './crew-runtime-tools.service';
import { hasBlockingReviewFinding } from './domain/crew-results';
import { CrewRunsRepository } from './persistence/crew-runs.repository';

@Injectable()
export class CrewStageResultsService {
  constructor(
    private readonly runs: CrewRunsRepository,
    private readonly gates: CrewGateEvidenceService,
  ) {}

  async accept(notice: CrewSubmissionNotice) {
    const run = this.requireRun(notice.runId);
    const result = notice.result.result;
    const common = {
      expectedRevision: run.revision, idempotencyKey: `result:${notice.result.id}`,
      actor: notice.memberKey,
    };
    if (result.kind === 'builder-intent') return run;
    if (result.kind === 'plan') {
      const contextPatch = {
        planSummary: result.summary, planSteps: result.steps,
        openQuestions: result.openQuestions,
      };
      if (result.materialClarification) {
        return this.runs.applyEvent(run.id, {
          ...common,
          event: { type: 'clarification_required', reason: result.materialClarification },
          contextPatch: { ...contextPatch, pendingClarification: result.materialClarification },
        });
      }
      return this.runs.applyEvent(run.id, {
        ...common, event: { type: 'plan_accepted' },
        contextPatch: { ...contextPatch, pendingClarification: null },
      });
    }
    if (result.kind === 'builder') {
      if (result.commitHead !== notice.workspaceHead || result.basedOnWorkspaceHead !== run.workspaceHead) {
        throw new Error('Crew Builder evidence is stale');
      }
      return this.runs.applyEvent(run.id, {
        ...common,
        event: {
          type: 'builder_completed', basedOnContextRevision: notice.result.basedOnContextRevision,
          workspaceHead: result.commitHead,
        },
        contextPatch: {
          lastBuild: { summary: result.summary, changedFiles: result.changedFiles }, priorFailure: null,
        },
      });
    }
    if (result.kind === 'review') {
      if (result.workspaceHead !== run.workspaceHead || notice.workspaceHead !== run.workspaceHead) {
        throw new Error('Crew Reviewer evidence is stale');
      }
      const blocking = hasBlockingReviewFinding(result);
      const finalReview = parseFinalReview(run.context.finalReview);
      const isFinalReviewer = finalReview?.status === 'active'
        && finalReview.memberSessionId === notice.result.memberSessionId
        && finalReview.workspaceHead === run.workspaceHead;
      if (finalReview?.status === 'active' && !isFinalReviewer) {
        throw new Error('Crew final Reviewer evidence is stale');
      }
      const contextPatch = {
        lastReview: { summary: result.summary, findings: result.findings },
        ...(blocking ? {
          priorFailure: { source: 'review', summary: reviewFailureSummary(result) },
        } : { priorFailure: null }),
      };
      if (!blocking && run.profileSnapshot.policy.strictFreshFinalReviewer
        && run.reviewRetriesUsed > 0 && !isFinalReviewer) {
        return this.runs.applyEvent(run.id, {
          ...common,
          event: { type: 'final_review_requested', basedOnWorkspaceHead: result.workspaceHead },
          contextPatch: {
            ...contextPatch,
            finalReview: {
              status: 'pending', workspaceHead: result.workspaceHead,
              requestedAfterMemberSessionId: notice.result.memberSessionId,
            },
          },
        });
      }
      return this.runs.applyEvent(run.id, {
        ...common,
        event: blocking
          ? { type: 'changes_requested', basedOnWorkspaceHead: result.workspaceHead }
          : { type: 'review_passed', basedOnWorkspaceHead: result.workspaceHead },
        contextPatch: { ...contextPatch, finalReview: null },
      });
    }
    if (run.status !== 'TERMINAL') await this.gates.assertCurrent(run);
    if (result.workspaceHead !== run.workspaceHead || notice.workspaceHead !== run.workspaceHead) {
      throw new Error('Crew synthesis evidence is stale');
    }
    return this.runs.applyEvent(run.id, {
      ...common,
      event: {
        type: 'synthesis_completed', basedOnContextRevision: notice.result.basedOnContextRevision,
        workspaceHead: result.workspaceHead,
      },
      contextPatch: {
        synthesis: {
          summary: result.summary, verification: result.verification,
          remainingRisks: result.remainingRisks,
        },
      },
    });
  }

  private requireRun(runId: string) {
    const run = this.runs.findById(runId);
    if (!run) throw new Error(`CrewRun ${runId} not found`);
    return run;
  }
}

function parseFinalReview(value: unknown): {
  status: 'pending' | 'active'; workspaceHead: string; memberSessionId?: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if ((row.status !== 'pending' && row.status !== 'active') || typeof row.workspaceHead !== 'string') return null;
  return {
    status: row.status, workspaceHead: row.workspaceHead,
    ...(typeof row.memberSessionId === 'string' ? { memberSessionId: row.memberSessionId } : {}),
  };
}

function reviewFailureSummary(result: Extract<CrewSubmissionNotice['result']['result'], { kind: 'review' }>) {
  return result.findings.filter((finding) => finding.severity === 'blocker')
    .map((finding) => `${finding.title}: ${finding.body}`).join('\n').slice(0, 16_384);
}
