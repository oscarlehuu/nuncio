import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { basename } from 'node:path';
import type { Clock } from '../../scheduler/scheduler.types';
import { ProjectsRepository } from '../../projects/projects.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { LoopsService } from '../../loops/loops.service';
import { AttentionRepository } from '../attention.repository';
import { ForgeRepoService } from '../../forges/forges-repo.service';
import type { AttentionItemDto } from '../attention.types';
import { foldHealth, orderFleet, topAttentionItem } from './fleet';
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
/** Best-effort forge PR count timeout — a slow/unreachable forge never blocks a row. */
const PR_COUNT_TIMEOUT_MS = 2500;

@Injectable()
export class FleetService implements OnModuleInit {
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

  constructor(
    @Optional() private readonly projects?: ProjectsRepository,
    @Optional() private readonly sessions?: SessionsRepository,
    @Optional() private readonly loops?: LoopsService,
    @Optional() private readonly attentionItems?: AttentionRepository,
    @Optional() private readonly forgeRepos?: ForgeRepoService,
  ) {}

  onModuleInit(): void {
    this.sources = () => this.gatherSources();
  }

  /** Derive the fold inputs from durable rows (called fresh per GET — no cache). */
  private gatherSources(): FleetSources {
    const projects = this.projects?.list() ?? [];
    const sessions = this.sessions?.list(false) ?? [];
    const loops = this.loops?.list() ?? [];

    const activePaths = new Set<string>();
    for (const s of sessions) if (s.projectPath) activePaths.add(s.projectPath);
    for (const l of loops) if (l.projectPath) activePaths.add(l.projectPath);

    const runningByPath = new Map<string, number>();
    const lastActivityByPath = new Map<string, number>();
    for (const s of sessions) {
      if (!s.projectPath) continue;
      if (s.status === 'RUNNING') runningByPath.set(s.projectPath, (runningByPath.get(s.projectPath) ?? 0) + 1);
      lastActivityByPath.set(s.projectPath, Math.max(lastActivityByPath.get(s.projectPath) ?? 0, s.updatedAt));
    }
    const activeLoopsByPath = new Map<string, number>();
    const lastVerifyByPath = new Map<string, 'green' | 'red' | 'none'>();
    for (const l of loops) {
      if (!l.projectPath) continue;
      if (l.status === 'active') activeLoopsByPath.set(l.projectPath, (activeLoopsByPath.get(l.projectPath) ?? 0) + 1);
      const runs = this.loops?.runs(l.id) ?? [];
      for (const r of runs) lastActivityByPath.set(l.projectPath, Math.max(lastActivityByPath.get(l.projectPath) ?? 0, r.createdAt));
      // Most recent settled verify signal wins (last green/red in the run list).
      for (const r of runs) if (r.verify === 'green' || r.verify === 'red') lastVerifyByPath.set(l.projectPath, r.verify);
    }

    return {
      configured: projects.map((p) => ({ path: p.path, name: p.name, weight: p.weight })),
      activePaths: [...activePaths],
      openAttention: this.attentionItems?.list('open') ?? [],
      runningSessionsByPath: (path) => runningByPath.get(path) ?? 0,
      activeLoopsByPath: (path) => activeLoopsByPath.get(path) ?? 0,
      openPRsByPath: (path) => this.openPrCount(path),
      lastVerifyByPath: (path) => lastVerifyByPath.get(path) ?? 'none',
      lastActivityByPath: (path) => lastActivityByPath.get(path) ?? null,
    };
  }

  /** Best-effort open-PR count: a slow/unreachable/unconfigured forge → 0, never blocks. */
  private async openPrCount(path: string): Promise<number> {
    if (!this.forgeRepos) return 0;
    try {
      const prs = await Promise.race([
        this.forgeRepos.listPullRequests(path, 'open'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), PR_COUNT_TIMEOUT_MS)),
      ]);
      return prs.length;
    } catch {
      return 0;
    }
  }

  /** One ordered fleet row per project (union population, derived on demand). */
  async list(): Promise<FleetRow[]> {
    const src = this.sources();

    // Population = configured ∪ active, deduped by path. A configured project
    // wins its name/weight; an unconfigured active path gets basename + weight 1.
    const byPath = new Map<string, FleetProjectSource>();
    for (const p of src.configured) byPath.set(p.path, p);
    for (const path of src.activePaths) {
      if (!byPath.has(path)) byPath.set(path, { path, name: basename(path) || path, weight: 1 });
    }

    // Group open attention items by project path once (O(items)).
    const openByPath = new Map<string, AttentionItemDto[]>();
    for (const item of src.openAttention) {
      if (!item.projectPath) continue;
      const list = openByPath.get(item.projectPath) ?? [];
      list.push(item);
      openByPath.set(item.projectPath, list);
    }
    const weights: Record<string, number> = {};
    for (const p of byPath.values()) weights[p.path] = p.weight;

    const rows = await Promise.all(
      [...byPath.values()].map(async (p) => this.buildRow(p, openByPath.get(p.path) ?? [], src, weights)),
    );
    return orderFleet(rows);
  }

  private async buildRow(
    project: FleetProjectSource,
    openItems: AttentionItemDto[],
    src: FleetSources,
    weights: Record<string, number>,
  ): Promise<FleetRow> {
    const openPRs = await src.openPRsByPath(project.path);
    const { health, reasons, counts } = foldHealth({
      path: project.path,
      name: project.name,
      weight: project.weight,
      openItems,
      runningSessions: src.runningSessionsByPath(project.path),
      activeLoops: src.activeLoopsByPath(project.path),
      openPRs,
      lastVerify: src.lastVerifyByPath(project.path),
      lastActivityAt: src.lastActivityByPath(project.path),
    });
    return {
      path: project.path,
      name: project.name,
      weight: project.weight,
      health,
      reasons,
      topItem: topAttentionItem(openItems, weights),
      counts,
      lastActivityAt: src.lastActivityByPath(project.path),
    };
  }
}
