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
 * support and so exposes no effort option. `ultracode` is Claude Code's own top
 * effort (xhigh reasoning + standing permission to orchestrate multi-agent
 * dynamic workflows) — the SDK forwards the string verbatim to the Claude Code
 * executable, which only offers it on xhigh-capable models.
 */

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;
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
            options: [effortOption()],
          },
          {
            id: 'claude:opus[1m]',
            name: 'Opus',
            sub: 'High capability',
            options: [effortOption()],
          },
          {
            id: 'claude:sonnet',
            name: 'Sonnet',
            sub: 'Balanced',
            options: [effortOption()],
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
