import { Injectable } from '@nestjs/common';
import type { Clock } from '../../scheduler/scheduler.types';
import type { AttentionItemDto } from '../attention.types';
import type { FleetRow } from './fleet.types';

/** A configured or recently-active project the fleet fold considers. */
export interface FleetProjectSource {
  path: string;
  name: string;
  weight: number;
}

/** The durable rows FleetService.list folds — all supplied by the wiring/seams. */
export interface FleetSources {
  /** Configured projects (projects table). */
  configured: FleetProjectSource[];
  /** Distinct project paths that have a recent session or loop (name/weight resolved). */
  activePaths: string[];
  openAttention: AttentionItemDto[];
  runningSessionsByPath: (path: string) => number;
  activeLoopsByPath: (path: string) => number;
  openPRsByPath: (path: string) => Promise<number>;
  lastVerifyByPath: (path: string) => 'green' | 'red' | 'none';
  lastActivityByPath: (path: string) => number | null;
}

/**
 * Fleet home (rung 3, sub-phase C). DERIVE-ON-DEMAND: `list()` is a pure fold at
 * GET time over the durable rows rungs 1-3 already keep — no materialized store,
 * no staleness. Population = configured projects ∪ projects with recent activity,
 * deduped by normalized path. Each row folds health + counts + verify streak +
 * lastActivity + topItem, then the whole list is ordered (red first).
 *
 * RED until implemented — neutral TODO, no false greens.
 */
@Injectable()
export class FleetService {
  clock: Clock = { now: () => Date.now() };

  /** Wiring/test seam: gather the durable rows to fold (bound in onModuleInit). */
  sources: () => FleetSources = () => ({
    configured: [],
    activePaths: [],
    openAttention: [],
    runningSessionsByPath: () => 0,
    activeLoopsByPath: () => 0,
    openPRsByPath: async () => 0,
    lastVerifyByPath: () => 'none',
    lastActivityByPath: () => null,
  });

  /** One ordered fleet row per project (union population, derived on demand). */
  async list(): Promise<FleetRow[]> {
    throw new Error('TODO: FleetService.list not implemented');
  }
}
