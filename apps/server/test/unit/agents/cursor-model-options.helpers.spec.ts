import {
  buildCursorModelParams,
  cursorParametersToDescriptors,
} from '../../../src/agents/providers/cursor-model-options.helpers';

describe('cursorParametersToDescriptors', () => {
  it('maps boolean fast parameter to a boolean descriptor', () => {
    const descriptors = cursorParametersToDescriptors([
      {
        id: 'fast',
        displayName: 'Fast Mode',
        values: [
          { value: 'false', displayName: 'Normal' },
          { value: 'true', displayName: 'Fast' },
        ],
      },
    ]);
    expect(descriptors).toEqual([
      {
        id: 'fast',
        label: 'Fast Mode',
        type: 'boolean',
        defaultValue: false,
      },
    ]);
  });

  it('maps multi-value reasoning parameter to a select descriptor', () => {
    const descriptors = cursorParametersToDescriptors([
      {
        id: 'reasoning',
        displayName: 'Reasoning',
        values: [
          { value: 'low', displayName: 'Low' },
          { value: 'high', displayName: 'High' },
        ],
      },
    ]);
    expect(descriptors[0]).toMatchObject({
      id: 'reasoning',
      type: 'select',
      defaultValue: 'low',
    });
    expect(descriptors[0]?.options).toHaveLength(2);
  });
});

describe('buildCursorModelParams', () => {
  const parameters = [
    {
      id: 'fast',
      values: [{ value: 'false' }, { value: 'true' }],
    },
    {
      id: 'reasoning',
      values: [{ value: 'low' }, { value: 'high' }],
    },
  ];

  it('builds params from explicit selections', () => {
    expect(buildCursorModelParams({ fast: true, reasoning: 'high' }, parameters)).toEqual([
      { id: 'fast', value: 'true' },
      { id: 'reasoning', value: 'high' },
    ]);
  });

  it('omits invalid selection values', () => {
    expect(buildCursorModelParams({ reasoning: 'invalid' }, parameters)).toEqual([
      { id: 'fast', value: 'false' },
    ]);
  });

  it('returns undefined when parameters are empty', () => {
    expect(buildCursorModelParams({ fast: true }, undefined)).toBeUndefined();
  });
});
