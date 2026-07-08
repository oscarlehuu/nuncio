export type FactProvenance = 'founder' | 'agent';
export type ProposalStatus = 'pending' | 'accepted' | 'dismissed';

export interface ContextFactRow {
  id: string;
  project_path: string;
  key: string;
  value: string;
  provenance: string;
  source_session_id: string | null;
  pinned: number;
  created_at: number;
  updated_at: number;
}

export interface ContextFactDto {
  id: string;
  projectPath: string;
  key: string;
  value: string;
  provenance: FactProvenance;
  sourceSessionId: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ContextFactProposalRow {
  id: string;
  project_path: string;
  key: string;
  proposed_value: string;
  source_session_id: string | null;
  status: string;
  created_at: number;
}

/**
 * Shaped so the rung-3 attention inbox can re-publish it unchanged later.
 */
export interface ContextFactProposalDto {
  id: string;
  projectPath: string;
  key: string;
  proposedValue: string;
  sourceSessionId: string | null;
  status: ProposalStatus;
  createdAt: number;
}

/** Input to a fact write; the caller sets provenance and (for agents) the source session. */
export interface UpsertContextFactInput {
  projectPath: string;
  key: string;
  value: string;
  provenance: FactProvenance;
  sourceSessionId?: string | null;
  pinned?: boolean;
}
