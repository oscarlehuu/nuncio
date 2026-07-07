import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { ProjectsRepository } from '../projects/projects.repository';
import type { Clock } from '../scheduler/scheduler.types';
import { AttentionRepository } from './attention.repository';
import { rankAttentionItems, severityForKind } from './attention-ranking';
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
 * pure static-bucket order weighted by project importance; a change sink powers
 * the phone badge without polling.
 */
@Injectable()
export class AttentionService {
  /** Injectable clock seam — deterministic in tests. */
  clock: Clock = { now: () => Date.now() };

  /** Badge-change sink; default no-op (prod wires it onto the session relay). */
  onChange: AttentionChangeSink = () => {};

  /** Per-kind live-state probes (auto-resolve + boot reconcile). */
  private readonly probes = new Map<string, ConditionProbe>();

  constructor(
    private readonly items: AttentionRepository,
    @Optional() private readonly projects?: ProjectsRepository,
  ) {}

  /** Register a per-kind live-state probe (auto-resolve + boot reconcile use it). */
  registerProbe(kind: string, probe: ConditionProbe): void {
    this.probes.set(kind, probe);
  }

  /**
   * Raise a signal: insert a fresh open item, or idempotently bump the existing
   * open one (dedup — no stacking). Rejects a malformed signal (missing
   * kind/subjectId) at the boundary. Emits a badge change.
   */
  raise(signal: RaiseSignal): AttentionItemDto {
    const kind = signal.kind?.trim();
    const subjectId = signal.subjectId?.trim();
    if (!kind) throw new BadRequestException('attention signal kind is required');
    if (!subjectId) throw new BadRequestException('attention signal subjectId is required');

    const item = this.items.raise({
      id: uuidv4().slice(0, 8),
      kind,
      subjectId,
      projectPath: signal.projectPath?.trim() || null,
      severity: severityForKind(kind),
      title: signal.title ?? kind,
      payloadJson: signal.payload ? JSON.stringify(signal.payload) : null,
      now: this.clock.now(),
    });
    this.emitChange();
    return item;
  }

  /** Ranked list + badge counts for the phone. */
  list(): { items: AttentionItemDto[]; counts: AttentionCounts } {
    const open = this.items.list('open');
    return { items: this.rank(open), counts: this.countsFrom(open) };
  }

  counts(): AttentionCounts {
    return this.countsFrom(this.items.list('open'));
  }

  /** Ack = "seen": mutes the badge, item stays open. 404 on unknown id. */
  acknowledge(id: string): AttentionItemDto {
    if (!this.items.findById(id)) throw new NotFoundException(`Attention item ${id} not found`);
    const acked = this.items.acknowledge(id, this.clock.now())!;
    this.emitChange();
    return acked;
  }

  /** Manual resolve (founder override) — terminal even if condition still live. */
  resolve(id: string): AttentionItemDto {
    if (!this.items.findById(id)) throw new NotFoundException(`Attention item ${id} not found`);
    const resolved = this.items.resolve(id, this.clock.now())!;
    this.emitChange();
    return resolved;
  }

  /**
   * Auto-resolve any open item whose condition has cleared (per its kind probe).
   * Called on the reconcile cadence and at boot — the attention analogue of the
   * rung-2 reconcilePendingRuns. An item whose kind has no registered probe is
   * left open (we cannot prove its condition cleared).
   */
  reconcileOpenItems(): void {
    let mutated = false;
    for (const item of this.items.list('open')) {
      const probe = this.probes.get(item.kind);
      if (probe && !probe(item)) {
        this.items.resolve(item.id, this.clock.now());
        mutated = true;
      }
    }
    if (mutated) this.emitChange();
  }

  private rank(open: AttentionItemDto[]): AttentionItemDto[] {
    return rankAttentionItems(open, this.projectWeights());
  }

  /** projectPath → weight, sourced from the project config (default 1). */
  private projectWeights(): Record<string, number> {
    const weights: Record<string, number> = {};
    for (const project of this.projects?.list() ?? []) {
      weights[project.path] = project.weight;
    }
    return weights;
  }

  /** total/unacked (open ∧ not acked — badge source) + per-severity breakdown. */
  private countsFrom(open: AttentionItemDto[]): AttentionCounts {
    const bySeverity: Record<string, number> = {};
    let unacked = 0;
    for (const item of open) {
      if (item.acknowledgedAt === null) unacked += 1;
      const key = String(item.severity);
      bySeverity[key] = (bySeverity[key] ?? 0) + 1;
    }
    return { total: open.length, unacked, bySeverity };
  }

  private emitChange(): void {
    try {
      this.onChange(this.counts());
    } catch {
      // A badge sink must never break a queue mutation.
    }
  }
}
