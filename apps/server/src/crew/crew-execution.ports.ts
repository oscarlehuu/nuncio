import type { AgentRuntimePolicy } from '../agents/agents.types';
import type { CrewRunPhase } from './domain/crew.types';

export const CREW_WORKSPACE_PORT = Symbol('CREW_WORKSPACE_PORT');
export const CREW_MEMBER_EXECUTION_PORT = Symbol('CREW_MEMBER_EXECUTION_PORT');
export const CREW_ATTENTION_PORT = Symbol('CREW_ATTENTION_PORT');

export interface CrewWorkspaceBoundary {
  ok: boolean;
  canonicalPath: string;
  exists: boolean;
  symlink: boolean;
  branch: string | null;
  fullHead: string | null;
  clean: boolean;
  reachable: boolean;
  reason: string | null;
}

export interface CrewWorkspacePort {
  resolveBase(
    projectPath: string, baseBranch?: string | null,
  ): Promise<{ baseBranch: string; baseHead: string }>;
  fileExistsAtRevision(
    projectPath: string, revision: string, relativePath: string,
  ): Promise<boolean>;
  createWorktree(input: {
    runId: string; projectPath: string; baseBranch: string; baseHead: string; slug: string;
  }): Promise<{ worktreePath: string; branch: string; baseBranch: string }>;
  inspectBoundary(path: string, expectation?: string | {
    expectedBranch?: string; expectedAncestorHead?: string; expectedCanonicalPath?: string;
  } | null): Promise<CrewWorkspaceBoundary>;
  checkpoint(path: string, message: string): Promise<{ fullHead: string; clean: boolean; committed: boolean }>;
  validateCheckpointRange(path: string, fromHead: string, toHead: string): Promise<void>;
  diff(path: string, baseRevision?: string | null): Promise<{ diff: string; truncated: boolean }>;
}

export interface CrewAttemptInput {
  idempotencyKey: string;
  runId: string;
  memberKey: string;
  phase: CrewRunPhase;
  prompt: string;
  provider: string;
  model: string;
  workspace: string;
  runtimePolicy: AgentRuntimePolicy;
  existingSessionId?: string | null;
}

export interface CrewAttemptHandle { taskId: string; sessionId: string | null; continued: boolean }
export interface CrewMemberExecutionPort {
  startAttempt(input: CrewAttemptInput): Promise<CrewAttemptHandle>;
  canResumeSession(sessionId: string): Promise<boolean>;
}

export interface CrewAttentionPort {
  raise(input: {
    kind: 'crew-blocked'; subjectId: string; projectPath: string;
    title: string; payload: Record<string, unknown>;
  }): void;
  clear(kind: 'crew-blocked', subjectId: string): void;
}
