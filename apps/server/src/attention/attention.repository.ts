import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import type { AttentionItemDto, AttentionStatus } from './attention.types';

/**
 * Durable attention_items store (ADR-006). One OPEN row per (kind, subjectId) —
 * enforced by a partial UNIQUE index over `status='open'` so a re-signal can
 * never stack, while a resolved row does not block a later re-trip. Restart-safe:
 * rows persist; open items are reconciled against live state on boot.
 *
 * RED until sub-phase A is implemented — every method throws a neutral TODO so
 * the reject/validation tests never false-green on a placeholder.
 */
@Injectable()
export class AttentionRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Upsert-open: insert a fresh open item, or bump an existing open one (dedup). */
  raise(input: {
    id: string;
    kind: string;
    subjectId: string;
    projectPath: string | null;
    severity: number;
    title: string;
    payloadJson: string | null;
    now: number;
  }): AttentionItemDto {
    throw new Error('TODO: AttentionRepository.raise not implemented');
    void input;
  }

  findById(id: string): AttentionItemDto | null {
    throw new Error('TODO: AttentionRepository.findById not implemented');
    void id;
  }

  /** The one OPEN item for a condition, or null. Drives dedup + auto-resolve. */
  findOpen(kind: string, subjectId: string): AttentionItemDto | null {
    throw new Error('TODO: AttentionRepository.findOpen not implemented');
    void kind;
    void subjectId;
  }

  list(status?: AttentionStatus): AttentionItemDto[] {
    throw new Error('TODO: AttentionRepository.list not implemented');
    void status;
  }

  /** Set acknowledged_at; the item stays OPEN (ack = seen, not resolved). */
  acknowledge(id: string, now: number): AttentionItemDto | null {
    throw new Error('TODO: AttentionRepository.acknowledge not implemented');
    void id;
    void now;
  }

  /** Terminal: status → resolved, resolved_at set (auto or manual). */
  resolve(id: string, now: number): AttentionItemDto | null {
    throw new Error('TODO: AttentionRepository.resolve not implemented');
    void id;
    void now;
  }
}
