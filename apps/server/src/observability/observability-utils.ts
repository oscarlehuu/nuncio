import type { ObservabilityQuery } from './observability.types';
import type { SessionEvent } from '../sessions/domain/sessions.types';

export function inWindow(at: number, query: ObservabilityQuery): boolean {
  return at >= query.window.from && at < query.window.to;
}

export function projectKey(projectPath: string | null | undefined): string {
  return projectPath?.trim() || 'unassigned';
}

export function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function payloadRecord(event: SessionEvent): Record<string, unknown> {
  return typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

export function verifyOk(event: SessionEvent): boolean {
  return payloadRecord(event).ok === true;
}
