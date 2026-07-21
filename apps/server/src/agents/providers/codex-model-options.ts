import type { ModelOptionDescriptorDto } from '../../models/model-options.types';

/** Shared Codex reasoning defaults — also used for Claude Codex-sub (Subscription bridge) catalog rows. */
export const DEFAULT_CODEX_REASONING_EFFORT = 'medium';

/** Includes `ultra` so GPT-5.6 Sol/Terra show the multi-agent tier without a live model/list probe. */
export const DEFAULT_CODEX_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra',
] as const;

export function codexReasoningEffortLabel(effort: string): string {
  switch (effort.toLowerCase()) {
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra High';
    case 'max':
      return 'Max';
    case 'ultra':
      return 'Ultra · Multi-agent';
    default:
      return effort;
  }
}

export function defaultCodexReasoningEffortOption(): ModelOptionDescriptorDto {
  return {
    id: 'reasoningEffort',
    label: 'Reasoning',
    type: 'select',
    defaultValue: DEFAULT_CODEX_REASONING_EFFORT,
    options: DEFAULT_CODEX_REASONING_EFFORTS.map((effort) => ({
      id: effort,
      label: codexReasoningEffortLabel(effort),
      isDefault: effort === DEFAULT_CODEX_REASONING_EFFORT,
    })),
  };
}

export function codexFastOption(): ModelOptionDescriptorDto {
  return {
    id: 'fast',
    label: 'Priority',
    type: 'boolean',
    defaultValue: false,
  };
}

export function defaultCodexModelOptions(): ModelOptionDescriptorDto[] {
  return [defaultCodexReasoningEffortOption(), codexFastOption()];
}
