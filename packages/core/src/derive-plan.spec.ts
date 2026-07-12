import { describe, expect, it } from 'vitest';
import { derivePlan } from './derive-plan';
import { normalizePlanItems, planProgress } from './plan.types';

describe('normalizePlanItems', () => {
  it('fills ids and default status, drops empty entries', () => {
    const items = normalizePlanItems([
      { text: 'Set up schema', status: 'done' },
      { text: 'Wire endpoint', status: 'in_progress', id: 'wire' },
      { text: '' },
      { text: 'Ship it', status: 'bogus' },
    ]);
    expect(items).toEqual([
      { id: 'item-1', text: 'Set up schema', status: 'done' },
      { id: 'wire', text: 'Wire endpoint', status: 'in_progress' },
      { id: 'item-4', text: 'Ship it', status: 'pending' },
    ]);
  });

  it('accepts a JSON-encoded string and rejects garbage', () => {
    expect(normalizePlanItems('[{"text":"a"}]')).toEqual([
      { id: 'item-1', text: 'a', status: 'pending' },
    ]);
    expect(normalizePlanItems('nope')).toBeUndefined();
    expect(normalizePlanItems({})).toBeUndefined();
    expect(normalizePlanItems([])).toBeUndefined();
  });
});

describe('derivePlan', () => {
  it('returns the latest snapshot', () => {
    const plan = derivePlan([
      { type: 'plan_updated', payload: { items: [{ text: 'one' }] } },
      { type: 'assistant_message', payload: {} },
      {
        type: 'plan_updated',
        payload: { items: [{ text: 'one', status: 'done' }, { text: 'two' }] },
      },
    ]);
    expect(plan).toEqual([
      { id: 'item-1', text: 'one', status: 'done' },
      { id: 'item-2', text: 'two', status: 'pending' },
    ]);
    expect(planProgress(plan!)).toEqual({ done: 1, total: 2 });
  });

  it('returns undefined without plan events', () => {
    expect(derivePlan([{ type: 'user_message', payload: {} }])).toBeUndefined();
  });
});
