import {
  codexFastOption,
  codexReasoningEffortLabel,
  defaultCodexModelOptions,
  defaultCodexReasoningEffortOption,
} from '../../../src/agents/providers/codex-model-options';

describe('codex-model-options', () => {
  describe('codexReasoningEffortLabel', () => {
    it('labels known efforts case-insensitively, including ultra multi-agent', () => {
      expect(codexReasoningEffortLabel('low')).toBe('Low');
      expect(codexReasoningEffortLabel('MEDIUM')).toBe('Medium');
      expect(codexReasoningEffortLabel('high')).toBe('High');
      expect(codexReasoningEffortLabel('xhigh')).toBe('Extra High');
      expect(codexReasoningEffortLabel('MAX')).toBe('Max');
      expect(codexReasoningEffortLabel('ultra')).toBe('Ultra · Multi-agent');
      expect(codexReasoningEffortLabel('ULTRA')).toBe('Ultra · Multi-agent');
    });

    it('returns the raw string for unknown efforts', () => {
      expect(codexReasoningEffortLabel('custom-tier')).toBe('custom-tier');
    });
  });

  describe('defaultCodexReasoningEffortOption', () => {
    it('exposes the static Sol/Terra tier list with medium default', () => {
      const option = defaultCodexReasoningEffortOption();
      expect(option).toMatchObject({
        id: 'reasoningEffort',
        label: 'Reasoning',
        type: 'select',
        defaultValue: 'medium',
      });
      expect(option.options?.map((o) => o.id)).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'ultra',
      ]);
      expect(option.options?.find((o) => o.id === 'medium')?.isDefault).toBe(true);
      expect(option.options?.find((o) => o.id === 'ultra')?.label).toBe(
        'Ultra · Multi-agent',
      );
      expect(option.options?.filter((o) => o.isDefault)).toHaveLength(1);
    });
  });

  describe('codexFastOption / defaultCodexModelOptions', () => {
    it('defaults Priority off and pairs Reasoning + Priority', () => {
      expect(codexFastOption()).toEqual({
        id: 'fast',
        label: 'Priority',
        type: 'boolean',
        defaultValue: false,
      });
      const options = defaultCodexModelOptions();
      expect(options).toHaveLength(2);
      expect(options[0]?.id).toBe('reasoningEffort');
      expect(options[1]?.id).toBe('fast');
    });
  });
});
