import { BadRequestException } from '@nestjs/common';
import type {
  CrewProfileDefinition, CrewProfileOverride, CrewProfilePolicy, CrewRole, CrewRoleBinding,
} from '../domain/crew.types';

const PROVIDERS = ['pi', 'codex', 'claude', 'devin', 'mock'] as const;
const ROLES: CrewRole[] = ['foreman', 'builder', 'reviewer'];
const DEFAULT_POLICY: CrewProfilePolicy = {
  maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true, verifyCommand: null,
};

export function requiredString(value: unknown, field: string, maxBytes = 16_384): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required`);
  const normalized = value.trim();
  if (normalized.includes('\0')) throw new BadRequestException(`${field} must not contain NUL`);
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new BadRequestException(`${field} must be at most ${maxBytes} UTF-8 bytes`);
  }
  return normalized;
}

export function expectedRevision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BadRequestException('expectedRevision must be a non-negative integer');
  }
  return value as number;
}

export function normalizeProfileDefinition(value: unknown): CrewProfileDefinition {
  const input = record(value, 'definition');
  for (const forbidden of ['workflow', 'phases', 'gates', 'fallback', 'members']) {
    if (forbidden in input) throw new BadRequestException(`${forbidden} is not configurable in Crew MVP`);
  }
  const rawBindings = record(input.bindings, 'definition.bindings');
  const bindings = Object.fromEntries(
    ROLES.map((role) => [role, binding(rawBindings[role], role)]),
  ) as Record<CrewRole, CrewRoleBinding>;
  return { bindings, policy: policy(input.policy, false) as CrewProfilePolicy };
}

export function normalizeOverride(value: unknown): CrewProfileOverride | undefined {
  if (value === undefined || value === null) return undefined;
  const input = record(value, 'override');
  const output: CrewProfileOverride = {};
  if (input.bindings !== undefined) {
    const rawBindings = record(input.bindings, 'override.bindings');
    output.bindings = {};
    for (const role of ROLES) if (rawBindings[role] !== undefined) output.bindings[role] = binding(rawBindings[role], role);
  }
  if (input.policy !== undefined) output.policy = policy(input.policy, true);
  return output;
}

export function cursorNumber(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new BadRequestException('invalid cursor value');
  return parsed;
}

function binding(value: unknown, role: CrewRole): CrewRoleBinding {
  const input = record(value, `${role} binding`);
  const provider = requiredString(input.provider, `${role}.provider`, 64);
  if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
    throw new BadRequestException(`${role}.provider must be pi, codex, claude, devin, or an enabled test-only mock`);
  }
  return {
    provider: provider as CrewRoleBinding['provider'],
    model: requiredString(input.model, `${role}.model`, 512),
  };
}

function policy(value: unknown, partial: boolean): Partial<CrewProfilePolicy> {
  if (value === undefined || value === null) return partial ? {} : { ...DEFAULT_POLICY };
  const input = record(value, 'policy');
  const output: Partial<CrewProfilePolicy> = partial ? {} : { ...DEFAULT_POLICY };
  for (const field of ['maxVerifyRetries', 'maxReviewRetries'] as const) {
    if (input[field] === undefined) continue;
    if (!Number.isInteger(input[field]) || (input[field] as number) < 0 || (input[field] as number) > 20) {
      throw new BadRequestException(`${field} must be an integer from 0 to 20`);
    }
    output[field] = input[field] as number;
  }
  if (input.strictFreshFinalReviewer !== undefined) {
    if (typeof input.strictFreshFinalReviewer !== 'boolean') throw new BadRequestException('strictFreshFinalReviewer must be boolean');
    output.strictFreshFinalReviewer = input.strictFreshFinalReviewer;
  }
  if (input.verifyCommand !== undefined) {
    if (input.verifyCommand !== null && typeof input.verifyCommand !== 'string') throw new BadRequestException('verifyCommand must be a string or null');
    output.verifyCommand = input.verifyCommand === null || !input.verifyCommand.trim()
      ? null : requiredString(input.verifyCommand, 'verifyCommand', 4096);
  }
  return output;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException(`${field} is required`);
  return value as Record<string, unknown>;
}
