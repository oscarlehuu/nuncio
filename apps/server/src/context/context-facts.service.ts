import { BadRequestException, Injectable } from '@nestjs/common';
import { byteLength } from '../orchestration/byte-truncate';
import { ContextFactProposalsRepository } from './context-fact-proposals.repository';
import { ContextFactsRepository } from './context-facts.repository';
import type {
  ContextFactDto,
  ContextFactProposalDto,
  UpsertContextFactInput,
} from './context-facts.types';

const KEY_SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VALUE_MAX_BYTES = 1024;

/** Outcome of an upsert: written directly, or rejected as a pending proposal. */
export interface UpsertOutcome {
  written: boolean;
  proposed: boolean;
  /** True when the new proposal evicted an older pending one for the same key (cap reached). */
  replacedProposal: boolean;
  fact: ContextFactDto | null;
  proposalId: string | null;
}

@Injectable()
export class ContextFactsService {
  constructor(
    private readonly facts: ContextFactsRepository,
    private readonly proposals: ContextFactProposalsRepository,
  ) {}

  list(projectPath: string): ContextFactDto[] {
    return this.facts.list(projectPath);
  }

  listPinnedFirst(projectPath: string, limit: number): ContextFactDto[] {
    return this.facts.listPinnedFirst(projectPath, limit);
  }

  count(projectPath: string): number {
    return this.facts.count(projectPath);
  }

  delete(id: string): boolean {
    return this.facts.delete(id);
  }

  /**
   * Validate and write a fact under the B3 precedence rules:
   *  1. a founder write always wins;
   *  2. an agent write on a new key is written directly (provenance agent);
   *  3. an agent write on an existing agent fact overwrites (latest wins);
   *  4. an agent write on an existing founder fact is rejected and stored as a
   *     pending proposal (deduped on key+value) — the founder fact is untouched.
   */
  upsert(input: UpsertContextFactInput): UpsertOutcome {
    const projectPath = input.projectPath?.trim();
    if (!projectPath) throw new BadRequestException('projectPath is required');
    if (!KEY_SLUG.test(input.key)) {
      throw new BadRequestException('key must be a kebab-case slug (2–64 chars, [a-z0-9-], no leading dash)');
    }
    if (typeof input.value !== 'string') throw new BadRequestException('value is required');
    if (byteLength(input.value) > VALUE_MAX_BYTES) {
      throw new BadRequestException(`value must be at most ${VALUE_MAX_BYTES} bytes`);
    }

    const existing = this.facts.getByKey(projectPath, input.key);

    // Rule 4: agent may not overwrite a founder fact — propose instead.
    if (input.provenance === 'agent' && existing?.provenance === 'founder') {
      const { proposal, replaced } = this.proposals.propose({
        projectPath,
        key: input.key,
        proposedValue: input.value,
        sourceSessionId: input.sourceSessionId ?? null,
      });
      return { written: false, proposed: true, replacedProposal: replaced, fact: existing, proposalId: proposal.id };
    }

    // Rules 1–3: write directly.
    const fact = this.facts.upsert({ ...input, projectPath });
    return { written: true, proposed: false, replacedProposal: false, fact, proposalId: null };
  }

  listProposals(projectPath: string): ContextFactProposalDto[] {
    return this.proposals.listPending(projectPath);
  }

  /** Accept a proposal: upsert the proposed value with FOUNDER provenance, mark it accepted. */
  acceptProposal(id: string): ContextFactProposalDto | null {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== 'pending') return null;
    // Flip status first (returns null if it raced to non-pending), then upsert.
    const accepted = this.proposals.setStatus(id, 'accepted');
    if (!accepted) return null;
    this.facts.upsert({
      projectPath: proposal.projectPath,
      key: proposal.key,
      value: proposal.proposedValue,
      provenance: 'founder',
    });
    return accepted;
  }

  dismissProposal(id: string): ContextFactProposalDto | null {
    return this.proposals.setStatus(id, 'dismissed');
  }
}
