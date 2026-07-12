import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@nuncio/core/plan.types';
import { planStepsLabel } from './session-plan-progress';

const item = (id: string, status: PlanItem['status']): PlanItem => ({ id, text: id, status });

describe('planStepsLabel', () => {
  it('is null with no plan', () => {
    expect(planStepsLabel(undefined)).toBeNull();
    expect(planStepsLabel([])).toBeNull();
  });

  it('counts done against total', () => {
    expect(
      planStepsLabel([item('a', 'done'), item('b', 'in_progress'), item('c', 'pending')]),
    ).toBe('1/3 steps');
  });

  it('reads all-done', () => {
    expect(planStepsLabel([item('a', 'done'), item('b', 'done')])).toBe('2/2 steps');
  });
});
