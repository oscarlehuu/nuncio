import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AttentionRepository } from '../attention/attention.repository';
import { AttentionService } from '../attention/attention.service';
import { AgentRegistry } from '../agents/agents.registry';
import type { Clock } from '../scheduler/scheduler.types';
import { SessionsService } from '../sessions/sessions.service';
import type { SessionDto } from '../sessions/domain/sessions.types';
import {
  gateFromAttentionItem,
  payloadFromAttentionItem,
  reproduceSubjectId,
} from './reproduce-gate';
import { buildMarkFixedSteer, buildProceedSteer } from './reproduce-steer';
import {
  LOG_CAP_BYTES,
  REPRODUCE_KIND,
  type ReproduceEventHandler,
  type ReproduceGateDto,
  type ReproducePayload,
  type RequestReproductionInput,
} from './reproduce.types';

/**
 * Owns the debug reproduction-gate lifecycle over the attention queue. A gate is
 * an attention item of kind `reproduce-requested`: `requested` = open (the
 * paused run waits here), `proceeded`/`fixed` = resolved terminal. Registers
 * itself as the session layer's reproduce event handler so a provider's
 * `request_reproduction` tool call becomes a durable, one-tap gate. Proceed and
 * Mark Fixed both resume the paused run through the EXISTING steer machinery.
 */
@Injectable()
export class ReproduceService implements ReproduceEventHandler {
  clock: Clock = { now: () => Date.now() };

  constructor(
    private readonly attention: AttentionService,
    private readonly items: AttentionRepository,
    private readonly sessions: SessionsService,
    private readonly agents: AgentRegistry,
  ) {
    this.sessions.registerReproduceHandler(this);
  }

  /** Session-layer seam: a provider emitted a reproduce tool event. */
  onReproduceEvent(sessionId: string, event: { type: string; payload: unknown }): void {
    if (event.type !== 'reproduce_requested') return;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const ref = typeof payload.ref === 'string' ? payload.ref.trim() : '';
    const steps = Array.isArray(payload.steps)
      ? payload.steps.filter((s): s is string => typeof s === 'string')
      : [];
    if (!ref || steps.length === 0) return; // the tool already validated; drop defensively
    this.request({
      sessionId,
      ref,
      steps,
      logsHint: typeof payload.logsHint === 'string' ? payload.logsHint : null,
    });
  }

  /**
   * Materialize a fresh open gate for a reproduction request. Rejects cleanly
   * when the session is gone or its engine does not advertise
   * `capabilities.reproduceGate` — the capability gate other engines fail.
   */
  request(input: RequestReproductionInput): ReproduceGateDto {
    const steps = input.steps.map((s) => s.trim()).filter((s) => s.length > 0);
    if (steps.length === 0) throw new BadRequestException('A reproduction gate needs at least one step.');
    const session = this.requireCapableSession(input.sessionId);
    const payload: ReproducePayload = {
      ref: input.ref,
      sessionId: session.id,
      steps,
      logsHint: input.logsHint?.trim() || null,
      logs: [],
      logBytes: 0,
      status: 'requested',
    };
    const item = this.attention.raise({
      kind: REPRODUCE_KIND,
      subjectId: reproduceSubjectId(session.id, input.ref),
      projectPath: session.projectPath,
      title: `Reproduce to debug: ${session.id}`,
      payload: payload as unknown as Record<string, unknown>,
    });
    return gateFromAttentionItem(item)!;
  }

  /** Open (requested) gates for a session — the session-view gate. */
  listForSession(sessionId: string): ReproduceGateDto[] {
    return this.items
      .list('open')
      .filter((item) => item.kind === REPRODUCE_KIND)
      .map(gateFromAttentionItem)
      .filter((gate): gate is ReproduceGateDto => gate !== null && gate.sessionId === sessionId);
  }

  get(gateId: string): ReproduceGateDto | null {
    const item = this.items.findById(gateId);
    return item && item.kind === REPRODUCE_KIND ? gateFromAttentionItem(item) : null;
  }

  /**
   * Append captured log lines to an open gate, size-capped. Empty/whitespace
   * lines are ignored; once the byte cap is reached the breaching line and the
   * rest of the batch are dropped (the gate stays usable and the prefix intact).
   * Rejects an append to an already-resolved gate.
   */
  appendLogs(gateId: string, lines: string[]): ReproduceGateDto {
    const payload = this.requirePayload(gateId);
    if (payload.status !== 'requested') {
      throw new BadRequestException('This reproduction gate is closed; logs can no longer be captured.');
    }
    const encoder = new TextEncoder();
    const accepted: string[] = [];
    let bytes = payload.logBytes;
    for (const raw of lines) {
      if (typeof raw !== 'string') continue;
      const line = raw.replace(/\s+$/, '');
      if (line.trim().length === 0) continue;
      const size = encoder.encode(line).byteLength;
      if (bytes + size > LOG_CAP_BYTES) break;
      accepted.push(line);
      bytes += size;
    }
    if (accepted.length === 0) return this.requireGate(gateId);
    this.items.updatePayload(
      gateId,
      { ...payload, logs: [...payload.logs, ...accepted], logBytes: bytes } as unknown as Record<string, unknown>,
      this.clock.now(),
    );
    return this.requireGate(gateId);
  }

  /**
   * Proceed: the user reproduced the failure. Resume the paused run with the
   * collected logs, then mark the gate terminal. The resume goes first so a
   * non-steerable session surfaces its error before the gate is consumed.
   */
  proceed(gateId: string): ReproduceGateDto {
    const payload = this.requireOpenPayload(gateId);
    this.resume(payload.sessionId, buildProceedSteer(payload));
    return this.resolveGate(gateId, payload, 'proceeded');
  }

  /**
   * Mark Fixed: the user confirmed the fix. Resume the run with the mechanical
   * sentinel-sweep instruction (D3), then mark the gate terminal.
   */
  markFixed(gateId: string): ReproduceGateDto {
    const payload = this.requireOpenPayload(gateId);
    this.resume(payload.sessionId, buildMarkFixedSteer());
    return this.resolveGate(gateId, payload, 'fixed');
  }

  private resolveGate(
    gateId: string,
    payload: ReproducePayload,
    status: 'proceeded' | 'fixed',
  ): ReproduceGateDto {
    this.items.updatePayload(
      gateId,
      { ...payload, status } as unknown as Record<string, unknown>,
      this.clock.now(),
    );
    this.attention.resolve(gateId);
    return this.requireGate(gateId);
  }

  /** Resume the paused run through the rung-1 steer path (fire-and-forget). */
  private resume(sessionId: string, message: string): void {
    this.sessions.steerInBackground(sessionId, message, undefined, undefined, 'reproduce-gate');
  }

  private requireGate(gateId: string): ReproduceGateDto {
    const gate = this.get(gateId);
    if (!gate) throw new NotFoundException(`Reproduction gate ${gateId} not found`);
    return gate;
  }

  private requirePayload(gateId: string): ReproducePayload {
    const item = this.items.findById(gateId);
    const payload = item && item.kind === REPRODUCE_KIND ? payloadFromAttentionItem(item) : null;
    if (!payload) throw new NotFoundException(`Reproduction gate ${gateId} not found`);
    return payload;
  }

  private requireOpenPayload(gateId: string): ReproducePayload {
    const payload = this.requirePayload(gateId);
    if (payload.status !== 'requested') {
      throw new BadRequestException('This reproduction gate is already resolved.');
    }
    return payload;
  }

  private requireCapableSession(sessionId: string): SessionDto {
    const session = this.sessions.get(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    const provider = this.agents.resolveForSession(session);
    if (provider.capabilities.reproduceGate !== true) {
      throw new BadRequestException(`Engine ${provider.id} does not support reproduction gates`);
    }
    return session;
  }
}
