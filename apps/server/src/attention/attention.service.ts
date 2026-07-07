import { Injectable } from '@nestjs/common';
import type { Clock } from '../scheduler/scheduler.types';
import { AttentionRepository } from './attention.repository';
import { rankAttentionItems } from './attention-ranking';
import type { AttentionCounts, AttentionItemDto, RaiseSignal } from './attention.types';

/**
 * A collector's live-state probe: given an open item, does its condition still
 * hold? Returning false auto-resolves the item (loop resumed → its breaker item
 * clears). Registered per kind so B/C add collectors without editing A's core.
 */
export type ConditionProbe = (item: AttentionItemDto) => boolean;

/** Badge sink — attention mutations emit here (rides the existing relay in prod). */
export type AttentionChangeSink = (counts: AttentionCounts) => void;

/**
 * The attention queue backbone (rung 3, sub-phase A). Collectors `raise` signals;
 * dedup keeps one open item per condition; ack mutes the badge without resolving;
 * resolve (auto on condition-clear, or manual override) is terminal; ranking is a
 * pure static-bucket order; a change sink powers the phone badge without polling.
 *
 * RED until implemented — neutral TODO throws, no false greens.
 */
@Injectable()
export class AttentionService {
  /** Injectable clock seam — deterministic in tests. */
  clock: Clock = { now: () => Date.now() };

  /** Badge-change sink; default no-op (prod wires it onto the session relay). */
  onChange: AttentionChangeSink = () => {};

  constructor(private readonly items: AttentionRepository) {}

  /** Register a per-kind live-state probe (auto-resolve + boot reconcile use it). */
  registerProbe(kind: string, probe: ConditionProbe): void {
    throw new Error('TODO: AttentionService.registerProbe not implemented');
    void kind;
    void probe;
  }

  /**
   * Raise a signal: insert a fresh open item, or idempotently bump the existing
   * open one (dedup — no stacking). Rejects a malformed signal (missing
   * kind/subjectId) at the boundary. Emits a badge change.
   */
  raise(signal: RaiseSignal): AttentionItemDto {
    throw new Error('TODO: AttentionService.raise not implemented');
    void signal;
  }

  /** Ranked list + badge counts for the phone. */
  list(): { items: AttentionItemDto[]; counts: AttentionCounts } {
    throw new Error('TODO: AttentionService.list not implemented');
  }

  counts(): AttentionCounts {
    throw new Error('TODO: AttentionService.counts not implemented');
  }

  /** Ack = "seen": mutes the badge, item stays open. 404 on unknown id. */
  acknowledge(id: string): AttentionItemDto {
    throw new Error('TODO: AttentionService.acknowledge not implemented');
    void id;
  }

  /** Manual resolve (founder override) — terminal even if condition still live. */
  resolve(id: string): AttentionItemDto {
    throw new Error('TODO: AttentionService.resolve not implemented');
    void id;
  }

  /**
   * Auto-resolve any open item whose condition has cleared (per its kind probe).
   * Called on the reconcile cadence and at boot — the attention analogue of the
   * rung-2 reconcilePendingRuns.
   */
  reconcileOpenItems(): void {
    throw new Error('TODO: AttentionService.reconcileOpenItems not implemented');
  }

  private rank(items: AttentionItemDto[]): AttentionItemDto[] {
    return rankAttentionItems(items);
  }
}
