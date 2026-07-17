import { Injectable } from '@nestjs/common';
import type { ModelProviderDto } from '../../models/models.types';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import type {
  MultitaskDecomposeInput,
  MultitaskDecomposition,
} from '../../sessions/domain/multitask-decompose';
import type { AgentCapabilities, AgentRunContext } from '../agents.types';
import { BaseAgentProvider } from '../agents.base-provider';
import { spawnTaskRef } from '../pi-engine/spawn-task-tool';
import { reproductionGateRef } from '../pi-engine/request-reproduction-tool';
import { isCrewRuntimeToolAllowed } from '../tools/agent-runtime-tools-policy';
import {
  normalizeAgentRuntimeToolResult,
  type AgentRuntimeTool,
} from '../tools/agent-runtime-tools.types';

const CREW_SUBMISSION_TOOLS = new Set([
  'submit_plan',
  'submit_build',
  'submit_review',
  'submit_synthesis',
]);

/**
 * Zero-credential fallback engine. Registered ONLY when the operator opts in with
 * `NUNCIO_FORCE_MOCK=1` (see `AgentsModule`) so it never appears in a normal boot
 * or the real model picker. Its purpose is deterministic, offline lifecycle
 * exercise — the scripted level-5 UI smoke drives create → stream → steer →
 * archive against it without touching a real provider or network.
 */
@Injectable()
export class MockAgentProvider extends BaseAgentProvider {
  readonly id = 'mock';
  readonly name = 'Mock';
  readonly capabilities: AgentCapabilities = {
    interrupt: false,
    modelSwitch: 'none',
    effortSwitch: 'none',
    images: false,
    steerWhileRunning: false,
    // The smoke drives the spawn-task chip flow against this offline engine.
    spawnTask: true,
    // The smoke drives the debug reproduction gate against this offline engine.
    reproduceGate: true,
    // Modes are accepted + persisted so the zero-credential smoke can drive the
    // composer's mode picker; the overlay itself is a Pi-side implementation.
    modes: ['debug', 'multitask'],
    // The smoke adapter never reads/writes the workspace, starts a shell, or
    // opens a network connection. Its only tool path is a trusted in-process
    // Crew stage submission with schema-bound authority fields.
    runtimePolicies: [
      { filesystem: 'read-only', network: 'disabled' },
      { filesystem: 'workspace-write', network: 'disabled' },
    ],
  };

  constructor(sessions: SessionsRepository, events: EventsRepository) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Deterministic 2-way split so the offline smoke can exercise the whole
   * multitask decompose → fan-out path without a real model. Always two
   * independent subtasks derived from the goal, regardless of the cap (cap only
   * ever raises the ceiling; the floor is two).
   */
  async decompose(input: MultitaskDecomposeInput): Promise<MultitaskDecomposition> {
    const goal = input.goal.trim() || 'the requested work';
    const summary = goal.split('\n')[0]?.slice(0, 80) ?? goal;
    return {
      subtasks: [
        {
          scope: `First half of: ${summary}`,
          prompt: `Multitask subtask 1 of 2 for "${goal}". Handle the first, independent half of the work.`,
          files: [],
        },
        {
          scope: `Second half of: ${summary}`,
          prompt: `Multitask subtask 2 of 2 for "${goal}". Handle the second, independent half of the work.`,
          files: [],
        },
      ],
      nonOverlap: 'The two subtasks touch disjoint areas and can run in parallel without ordering.',
    };
  }

  async listModels(): Promise<ModelProviderDto[]> {
    return [
      {
        id: this.id,
        name: this.name,
        sub: 'Local fallback agent',
        icon: 'M',
        groups: [
          {
            id: 'mock',
            name: 'Mock',
            sub: 'No external auth required',
            models: ['default', 'foreman', 'builder', 'reviewer'].map((role) => ({
              id: `mock:${role}`,
              name: role === 'default'
                ? 'Mock Agent'
                : `Mock ${role[0]!.toUpperCase()}${role.slice(1)}`,
              sub: 'Simulated response stream',
              badge: 'local',
            })),
          },
        ],
      },
    ];
  }

  protected async executePrompt(
    sessionId: string,
    userText: string,
    isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    const reply = isSteer
      ? `Steer received: "${userText.slice(0, 60)}${userText.length > 60 ? '...' : ''}". Continuing in mock mode.`
      : 'I received your task. In mock mode (agent auth not configured), I simulate agent output. ' +
        'Configure a real provider to use an agent SDK harness.';

    for (let i = 0; i < reply.length; i += 8) {
      const delta = reply.slice(i, i + 8);
      this.pushEvent(sessionId, 'assistant_delta', { delta }, context.emit);
      this.touchPreview(sessionId, reply.slice(0, i + 8), context.emit);
      await sleep(30);
    }

    this.pushEvent(sessionId, 'assistant_message', { text: reply }, context.emit);
    if (!isSteer && wantsSpawnChip(userText)) {
      this.emitMockSpawnChip(sessionId, context);
    }
    if (!isSteer && wantsReproduceGate(userText)) {
      this.emitMockReproduceGate(sessionId, context);
    }
    await submitMockCrewResult(context);
  }

  /**
   * Deterministic reproduction gate so the offline smoke can drive the whole
   * request → gate → Proceed/Mark-Fixed flow without a real model. The turn ends
   * after emitting it, so the session goes IDLE and the gate's actions can steer
   * it back into a run. Only fires on the marker so it never pollutes other
   * Mock-driven smokes.
   */
  private emitMockReproduceGate(sessionId: string, context: AgentRunContext): void {
    this.pushEvent(
      sessionId,
      'reproduce_requested',
      {
        steps: [
          'From the worktree root, run: NUNCIO_SMOKE_DEBUG_FAIL=signal bun run test:smoke-ui',
          'When it exits, note any Chrome/server PIDs still alive (ps -p <pid>).',
          'Press Proceed when the logs are captured, or Mark Fixed once the bug is gone.',
        ],
        logsHint: 'Watch stderr for the "// nuncio-debug" NDJSON lines the instrumentation prints.',
        ref: reproductionGateRef(sessionId, 'mock-1'),
      },
      context.emit,
    );
  }

  /**
   * Deterministic spawn-task chip so the offline smoke can drive the whole
   * propose → tap → child-session flow without a real model. Only fires when the
   * prompt asks for it, so it never pollutes the other Mock-driven smokes.
   */
  private emitMockSpawnChip(sessionId: string, context: AgentRunContext): void {
    const title = 'Remove the dead retry path in relay.ts';
    const prompt =
      'In apps/server/src/relay/relay.service.ts the second retry branch (guarded by legacyMode) has been unreachable since the queue refactor. Delete it and its helper, then update the relay unit test to match.';
    this.pushEvent(
      sessionId,
      'spawn_task_proposed',
      {
        title,
        tldr: 'The legacy retry branch in relay.ts is unreachable after the queue refactor and should be removed.',
        prompt,
        ref: spawnTaskRef(title, prompt),
      },
      context.emit,
    );
  }
}

/** The offline smoke asks for a chip with this marker; real prompts never carry it. */
function wantsSpawnChip(userText: string): boolean {
  return /\bspawn-chip\b/i.test(userText);
}

/** The offline smoke asks for a reproduction gate with this marker. */
function wantsReproduceGate(userText: string): boolean {
  return /\breproduce-gate\b/i.test(userText);
}

async function submitMockCrewResult(context: AgentRunContext): Promise<void> {
  if (!context.runtimePolicy) return;
  const submissions = context.tools?.tools.filter(
    (tool) => CREW_SUBMISSION_TOOLS.has(tool.name)
      && isCrewRuntimeToolAllowed(tool, context.runtimePolicy!),
  ) ?? [];
  if (submissions.length === 0) return;
  const active = submissions.flatMap((tool) => {
    const authority = tool.testInput?.() ?? schemaBoundAuthority(tool);
    return authority ? [{ tool, input: { ...authority, result: mockResultFor(tool.name) } }] : [];
  });
  if (active.length !== 1) {
    throw new Error('Mock Crew run requires exactly one trusted stage submission tool.');
  }

  const { tool, input } = active[0]!;
  const result = normalizeAgentRuntimeToolResult(await tool.execute(input));
  if (result.isError) {
    const reason = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    throw new Error(reason || `Mock Crew submission ${tool.name} failed.`);
  }
}

function schemaBoundAuthority(tool: AgentRuntimeTool): Record<string, unknown> | null {
  try {
    return {
      runId: requiredSchemaConst(tool, 'runId', 'string'),
      memberKey: requiredSchemaConst(tool, 'memberKey', 'string'),
      contextRevision: requiredSchemaConst(tool, 'contextRevision', 'number'),
      workspaceHead: requiredSchemaConst(tool, 'workspaceHead', 'string'),
      idempotencyKey: requiredSchemaConst(tool, 'idempotencyKey', 'string'),
    };
  } catch {
    return null;
  }
}

function requiredSchemaConst(
  tool: AgentRuntimeTool,
  field: string,
  expectedType: 'string' | 'number',
): string | number {
  const properties = tool.inputSchema.properties;
  const property = properties && typeof properties === 'object' && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)[field]
    : undefined;
  const value = property && typeof property === 'object' && !Array.isArray(property)
    ? (property as Record<string, unknown>).const
    : undefined;
  if (expectedType === 'string') {
    if (typeof value === 'string' && value.length > 0) return value;
  } else if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`Mock Crew tool ${tool.name} must bind ${field} with JSON Schema const.`);
}

function mockResultFor(toolName: string): Record<string, unknown> {
  switch (toolName) {
    case 'submit_plan':
      return {
        summary: 'Mock plan accepted for the deterministic Crew smoke run.',
        steps: ['Run the deterministic Crew smoke workflow.'],
        openQuestions: [],
      };
    case 'submit_build':
      return { summary: 'Mock build completed without host edits.', changedFiles: [] };
    case 'submit_review':
      return { summary: 'Mock review completed with no blocking findings.', findings: [] };
    case 'submit_synthesis':
      return {
        summary: 'Mock Crew smoke run completed.',
        verification: 'Deterministic smoke verification passed.',
        remainingRisks: [],
      };
    default:
      throw new Error(`Unsupported Mock Crew submission tool: ${toolName}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
