import type { ModelOptionDescriptorDto } from '../../models/model-options.types';
import type { ModelProviderDto } from '../../models/models.types';

/**
 * Static v1 catalog for the Claude provider. The SDK's `initializationResult()`
 * exposes the live model list, but a cold probe query is too expensive to run
 * for a picker listing — driving the catalog from init is a marked fast-follow.
 *
 * `id` is `claude:<value>` where `<value>` is the exact model string the SDK's
 * `options.model` / `setModel()` accept (the provider strips the `claude:`
 * prefix). Effort options mirror the SDK's supported levels; Haiku has no effort
 * support and so exposes no effort option.
 */

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const DEFAULT_EFFORT = 'high';

function effortOption(): ModelOptionDescriptorDto {
  return {
    id: 'effort',
    label: 'Effort',
    type: 'select',
    defaultValue: DEFAULT_EFFORT,
    options: EFFORT_LEVELS.map((level) => ({
      id: level,
      label: level,
      isDefault: level === DEFAULT_EFFORT,
    })),
  };
}

/** Claude Code session flag: xhigh + standing dynamic-workflow orchestration (SDK Settings.ultracode). */
export function ultracodeOption(): ModelOptionDescriptorDto {
  return {
    id: 'ultracode',
    label: 'Ultracode',
    type: 'boolean',
    defaultValue: false,
  };
}

function effortfulModelOptions(): ModelOptionDescriptorDto[] {
  return [effortOption(), ultracodeOption()];
}

export const CLAUDE_STATIC_MODELS: ModelProviderDto[] = [
  {
    id: 'claude',
    name: 'Claude',
    sub: 'Claude Code · @anthropic-ai/claude-agent-sdk',
    icon: '✳',
    groups: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        sub: 'Claude Code models',
        models: [
          {
            id: 'claude:claude-fable-5[1m]',
            name: 'Fable',
            sub: 'Most capable',
            options: effortfulModelOptions(),
          },
          {
            id: 'claude:opus[1m]',
            name: 'Opus',
            sub: 'High capability',
            options: effortfulModelOptions(),
          },
          {
            id: 'claude:sonnet',
            name: 'Sonnet',
            sub: 'Balanced',
            options: effortfulModelOptions(),
          },
          {
            id: 'claude:haiku',
            name: 'Haiku',
            sub: 'Fast + cheap',
          },
        ],
      },
    ],
  },
];
