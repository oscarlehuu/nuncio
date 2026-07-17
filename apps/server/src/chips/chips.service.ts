import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AttentionRepository } from '../attention/attention.repository';
import { AttentionService } from '../attention/attention.service';
import { AgentRegistry } from '../agents/agents.registry';
import {
  normalizeSpawnTaskInput,
  spawnTaskRef,
} from '../agents/pi-engine/spawn-task-tool';
import type { Clock } from '../scheduler/scheduler.types';
import { SessionsService } from '../sessions/sessions.service';
import type { SessionDto } from '../sessions/domain/sessions.types';
import {
  chipFromAttentionItem,
  chipSubjectId,
} from './spawn-task-chip';
import {
  SPAWN_TASK_KIND,
  type ChipDismisser,
  type ChipDto,
  type ChipPayload,
  type ProposeChipInput,
  type SpawnTaskEventHandler,
} from './chips.types';

/**
 * Owns the spawn-task chip lifecycle over the attention queue. A chip is an
 * attention item of kind `spawn-task`: proposed = open, acted/dismissed =
 * resolved (terminal — the attention re-raise suppression makes an acted or
 * dismissed chip un-retriggerable). Registers itself as the session layer's
 * spawn-task event handler so provider tool calls become durable chips.
 */
@Injectable()
export class ChipsService implements SpawnTaskEventHandler {
  clock: Clock = { now: () => Date.now() };

  constructor(
    private readonly attention: AttentionService,
    private readonly items: AttentionRepository,
    private readonly sessions: SessionsService,
    private readonly agents: AgentRegistry,
  ) {
    this.sessions.registerChipHandler(this);
  }

  /** Session-layer seam: a provider emitted a spawn-task tool event. */
  onSpawnTaskEvent(sourceSessionId: string, event: { type: string; payload: unknown }): void {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === 'spawn_task_proposed') {
      const normalized = normalizeSpawnTaskInput(payload);
      if ('error' in normalized) return; // the tool already rejected bad input; drop defensively
      this.propose({ sourceSessionId, ...normalized.value });
      return;
    }
    if (event.type === 'spawn_task_dismissed') {
      const ref = typeof payload.id === 'string' ? payload.id.trim() : '';
      const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
      if (ref) this.dismissByRef(sourceSessionId, ref, { by: 'agent', reason });
    }
  }

  /**
   * Materialize a proposed chip (deduped by source session + title+prompt hash).
   * Rejects cleanly when the source session is gone or its engine does not
   * advertise `capabilities.spawnTask` — the capability gate other engines fail.
   */
  propose(input: ProposeChipInput): ChipDto {
    const normalized = normalizeSpawnTaskInput(input);
    if ('error' in normalized) throw new BadRequestException(normalized.error);
    const session = this.requireCapableSession(input.sourceSessionId);
    const { title, tldr, prompt, cwd } = normalized.value;
    const ref = spawnTaskRef(title, prompt);
    const payload: ChipPayload = {
      ref,
      sourceSessionId: session.id,
      tldr,
      prompt,
      cwd: cwd ?? input.cwd ?? null,
      status: 'proposed',
    };
    const item = this.attention.raise({
      kind: SPAWN_TASK_KIND,
      subjectId: chipSubjectId(session.id, ref),
      projectPath: session.projectPath,
      title,
      payload: payload as unknown as Record<string, unknown>,
    });
    return chipFromAttentionItem(item)!;
  }

  /** Open chips (proposed) for a source session — the session-view chip row. */
  listForSession(sourceSessionId: string): ChipDto[] {
    return this.items
      .list('open')
      .filter((item) => item.kind === SPAWN_TASK_KIND)
      .map(chipFromAttentionItem)
      .filter((chip): chip is ChipDto => chip !== null && chip.sourceSessionId === sourceSessionId);
  }

  get(chipId: string): ChipDto | null {
    const item = this.items.findById(chipId);
    return item && item.kind === SPAWN_TASK_KIND ? chipFromAttentionItem(item) : null;
  }

  /**
   * Spin the chip into its own session, inheriting the source session's engine +
   * model (no silent model swap) and linked as a lineage child. Idempotent on a
   * double-tap: a laggy re-tap returns the already-created child, never a second
   * session. Rejects a chip that was already dismissed.
   */
  async act(chipId: string): Promise<{ chip: ChipDto; session: SessionDto }> {
    const chip = this.requireChip(chipId);
    if (chip.status === 'acted' && chip.childSessionId) {
      const existing = this.sessions.get(chip.childSessionId);
      if (existing) return { chip, session: existing };
    }
    if (chip.status === 'dismissed') {
      throw new BadRequestException('This chip was dismissed and can no longer be spawned.');
    }
    const source = this.sessions.get(chip.sourceSessionId);
    if (!source) throw new NotFoundException('The source session no longer exists.');

    const workspace = chip.cwd ?? source.workspace ?? undefined;
    const child = await this.sessions.create({
      prompt: chip.prompt,
      ...(source.provider ? { provider: source.provider } : {}),
      ...(source.model ? { model: source.model } : {}),
      ...(source.projectPath ? { projectPath: source.projectPath } : {}),
      ...(workspace ? { workspace } : {}),
      parentSessionId: source.id,
    });

    const now = this.clock.now();
    this.items.updatePayload(chipId, this.terminalPayload(chip, 'acted', { childSessionId: child.id }), now);
    this.attention.resolve(chipId);
    return { chip: this.requireChip(chipId), session: child };
  }

  /** User dismiss (Home queue / session row). Idempotent on an already-dismissed chip. */
  dismiss(chipId: string, opts: { by: ChipDismisser; reason?: string }): ChipDto {
    const chip = this.requireChip(chipId);
    if (chip.status === 'dismissed') return chip;
    if (chip.status === 'acted') {
      throw new BadRequestException('This chip was already spawned into a session.');
    }
    const now = this.clock.now();
    this.items.updatePayload(
      chipId,
      this.terminalPayload(chip, 'dismissed', {
        dismissedBy: opts.by,
        ...(opts.reason ? { dismissReason: opts.reason } : {}),
      }),
      now,
    );
    this.attention.resolve(chipId);
    return this.requireChip(chipId);
  }

  /** Agent dismiss via dismiss_task(ref) — resolves the open chip for that ref, or no-ops. */
  dismissByRef(sourceSessionId: string, ref: string, opts: { by: ChipDismisser; reason?: string }): ChipDto | null {
    const open = this.items.findOpen(SPAWN_TASK_KIND, chipSubjectId(sourceSessionId, ref));
    if (!open) return null;
    return this.dismiss(open.id, opts);
  }

  private terminalPayload(
    chip: ChipDto,
    status: 'acted' | 'dismissed',
    extra: Partial<ChipPayload>,
  ): Record<string, unknown> {
    const payload: ChipPayload = {
      ref: chip.ref,
      sourceSessionId: chip.sourceSessionId,
      tldr: chip.tldr,
      prompt: chip.prompt,
      cwd: chip.cwd,
      status,
      ...(chip.dismissedBy ? { dismissedBy: chip.dismissedBy } : {}),
      ...(chip.dismissReason ? { dismissReason: chip.dismissReason } : {}),
      ...(chip.childSessionId ? { childSessionId: chip.childSessionId } : {}),
      ...extra,
    };
    return payload as unknown as Record<string, unknown>;
  }

  private requireChip(chipId: string): ChipDto {
    const chip = this.get(chipId);
    if (!chip) throw new NotFoundException(`Chip ${chipId} not found`);
    return chip;
  }

  private requireCapableSession(sessionId: string): SessionDto {
    const session = this.sessions.get(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    const provider = this.agents.resolveForSession(session);
    if (provider.capabilities.spawnTask !== true) {
      throw new BadRequestException(`Engine ${provider.id} does not support spawn-task chips`);
    }
    return session;
  }
}
