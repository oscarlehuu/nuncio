import {
  MULTITASK_DEFAULT_CAP,
  MULTITASK_MAX_SUBTASKS,
  MULTITASK_MIN_SUBTASKS,
  clampSubtaskCap,
  normalizeDecomposition,
} from '../../../src/sessions/domain/multitask-decompose';

const twoValidSubtasks = {
  subtasks: [
    { scope: 'a', prompt: 'do a' },
    { scope: 'b', prompt: 'do b' },
  ],
  nonOverlap: 'disjoint',
};

describe('clampSubtaskCap', () => {
  it('clamps to the supported [MIN, MAX] range and defaults on garbage', () => {
    expect(clampSubtaskCap(1)).toBe(MULTITASK_MIN_SUBTASKS);
    expect(clampSubtaskCap(0)).toBe(MULTITASK_MIN_SUBTASKS);
    expect(clampSubtaskCap(99)).toBe(MULTITASK_MAX_SUBTASKS);
    expect(clampSubtaskCap('4')).toBe(4);
    expect(clampSubtaskCap('nonsense')).toBe(MULTITASK_DEFAULT_CAP);
    expect(clampSubtaskCap(undefined)).toBe(MULTITASK_DEFAULT_CAP);
    expect(clampSubtaskCap(3.9)).toBe(3); // truncated
  });
});

describe('normalizeDecomposition', () => {
  it('keeps a valid two-subtask split and trims the non-overlap', () => {
    const result = normalizeDecomposition({
      subtasks: [
        { scope: '  a  ', prompt: '  do a  ' },
        { scope: 'b', prompt: 'do b', files: ['x.ts', '  ', 'y.ts'] },
      ],
      nonOverlap: '  disjoint  ',
    });
    expect(result.subtasks).toEqual([
      { scope: 'a', prompt: 'do a' },
      { scope: 'b', prompt: 'do b', files: ['x.ts', 'y.ts'] },
    ]);
    expect(result.nonOverlap).toBe('disjoint');
  });

  it('throws when the raw is not an object with a subtasks array', () => {
    expect(() => normalizeDecomposition(null)).toThrow();
    expect(() => normalizeDecomposition([twoValidSubtasks])).toThrow();
    expect(() => normalizeDecomposition({ subtasks: 'nope' })).toThrow();
  });

  it('throws below the floor of two independent subtasks', () => {
    expect(() => normalizeDecomposition({ subtasks: [] })).toThrow();
    expect(() => normalizeDecomposition({ subtasks: [{ scope: 'a', prompt: 'do a' }] })).toThrow();
  });

  it('drops empty-prompt entries and throws if that leaves fewer than two', () => {
    expect(() =>
      normalizeDecomposition({
        subtasks: [
          { scope: 'a', prompt: '  ' },
          { scope: 'b', prompt: 'do b' },
        ],
      }),
    ).toThrow();
  });

  it('clamps extra subtasks down to the cap', () => {
    const many = { subtasks: Array.from({ length: 7 }, (_, i) => ({ prompt: `do ${i}` })) };
    expect(normalizeDecomposition(many, 3).subtasks).toHaveLength(3);
    expect(normalizeDecomposition(many).subtasks).toHaveLength(MULTITASK_MAX_SUBTASKS);
  });

  it('defaults a missing scope to the prompt first line and a missing non-overlap to empty', () => {
    const result = normalizeDecomposition({
      subtasks: [
        { prompt: 'first line\nsecond line' },
        { prompt: 'do b' },
      ],
    });
    expect(result.subtasks[0]!.scope).toBe('first line');
    expect(result.nonOverlap).toBe('');
  });

  it('skips non-object subtask entries without crashing', () => {
    const result = normalizeDecomposition({
      subtasks: [null, 'nope', { prompt: 'do a' }, { prompt: 'do b' }],
    });
    expect(result.subtasks.map((s) => s.prompt)).toEqual(['do a', 'do b']);
  });
});
