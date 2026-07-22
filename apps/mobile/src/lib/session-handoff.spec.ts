import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '@nuncio/core/model-providers';
import { canHandoffSession, handoffTargets } from './session-handoff';

const CATALOG: ModelProvider[] = [
  { id: 'pi', name: 'Nuncio Engine' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'anthropic-direct', name: 'Anthropic', unavailable: true },
];

describe('canHandoffSession', () => {
  it.each([
    ['IDLE', true],
    ['PAUSED', true],
    ['ERROR', true],
    ['RUNNING', false],
    ['CREATED', false],
    ['ARCHIVED', false],
  ] as const)('returns %s → %s for a session', (status, expected) => {
    expect(canHandoffSession(status)).toBe(expected);
  });

  it('is false while the session has not loaded yet', () => {
    expect(canHandoffSession(undefined)).toBe(false);
    expect(canHandoffSession(null)).toBe(false);
  });
});

describe('handoffTargets', () => {
  it('excludes the current provider and any unavailable engines', () => {
    expect(handoffTargets(CATALOG, 'pi').map((p) => p.id)).toEqual(['cursor']);
  });

  it('offers every available engine when the session provider is unknown to the catalog', () => {
    expect(handoffTargets(CATALOG, 'devin').map((p) => p.id)).toEqual(['pi', 'cursor']);
  });

  it('returns an empty list for an empty catalog', () => {
    expect(handoffTargets([], 'pi')).toEqual([]);
  });

  it('returns an empty list when only the current + unavailable engines exist', () => {
    const catalog: ModelProvider[] = [
      { id: 'pi', name: 'Nuncio Engine' },
      { id: 'anthropic-direct', name: 'Anthropic', unavailable: true },
    ];
    expect(handoffTargets(catalog, 'pi')).toEqual([]);
  });
});
