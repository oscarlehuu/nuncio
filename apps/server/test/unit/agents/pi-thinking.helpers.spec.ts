import {
  piThinkingDescriptors,
  resolvePiThinkingLevel,
} from '../../../src/agents/providers/pi-thinking.helpers';

describe('piThinkingDescriptors', () => {
  it('returns empty list when model does not support reasoning', () => {
    expect(piThinkingDescriptors({ reasoning: false })).toEqual([]);
    expect(piThinkingDescriptors(undefined)).toEqual([]);
  });

  it('returns thinkingLevel select when model supports reasoning', () => {
    const descriptors = piThinkingDescriptors({ reasoning: true });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      id: 'thinkingLevel',
      type: 'select',
      defaultValue: 'medium',
    });
    expect(descriptors[0]?.options?.map((o) => o.id)).toContain('high');
  });

  it('filters levels using thinkingLevelMap null entries', () => {
    const descriptors = piThinkingDescriptors({
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: 'min', medium: 'med', high: 'hi' },
    });
    const ids = descriptors[0]?.options?.map((o) => o.id) ?? [];
    expect(ids).not.toContain('off');
    expect(ids).toContain('minimal');
  });
});

describe('resolvePiThinkingLevel', () => {
  const model = { reasoning: true };

  it('returns selected level when valid', () => {
    expect(resolvePiThinkingLevel({ thinkingLevel: 'high' }, model)).toBe('high');
  });

  it('falls back to default when selection is invalid', () => {
    expect(resolvePiThinkingLevel({ thinkingLevel: 'bogus' }, model)).toBe('medium');
  });
});
