import { buildSubagentTaskInput } from '../../../src/tasks/multitask-defaults';
import type { SettingsService } from '../../../src/settings/settings.service';
import type { SessionDto } from '../../../src/sessions/domain/sessions.types';
import type { StartMultitaskDto } from '../../../src/tasks/tasks.types';

/** Minimal SettingsService fake: only resolve() is exercised here. */
function fakeSettings(values: Record<string, string | undefined>): SettingsService {
  return { resolve: (key: string) => values[key] } as unknown as SettingsService;
}

function parentSession(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 'parent1',
    provider: 'pi',
    model: 'pi:parent-model',
    modelOptions: { reasoningEffort: 'high' },
    workspace: null,
    projectPath: null,
    baseBranch: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  } as SessionDto;
}

const baseInput: StartMultitaskDto = { parentSessionId: 'parent1', prompts: ['go'] };

describe('buildSubagentTaskInput — per-provider default models', () => {
  it('prefers the NUNCIO_SUBAGENT_MODELS map over the legacy default and the parent model', () => {
    const settings = fakeSettings({
      NUNCIO_SUBAGENT_MODELS: JSON.stringify({ pi: 'pi:mapped-model' }),
      NUNCIO_SUBAGENT_MODEL: 'pi:legacy-model',
    });
    const result = buildSubagentTaskInput(baseInput, parentSession(), 'go', settings);
    expect(result.model).toBe('pi:mapped-model');
  });

  it('looks the map up by the resolved provider, not the parent provider', () => {
    const settings = fakeSettings({
      NUNCIO_SUBAGENT_PROVIDER: 'codex',
      NUNCIO_SUBAGENT_MODELS: JSON.stringify({ codex: 'codex:mapped', pi: 'pi:mapped' }),
    });
    const result = buildSubagentTaskInput(baseInput, parentSession({ provider: 'pi' }), 'go', settings);
    expect(result.provider).toBe('codex');
    expect(result.model).toBe('codex:mapped');
  });

  it('falls through to the legacy default when the map JSON is invalid', () => {
    const settings = fakeSettings({
      NUNCIO_SUBAGENT_MODELS: '{ not valid json',
      NUNCIO_SUBAGENT_MODEL: 'pi:legacy-model',
    });
    const result = buildSubagentTaskInput(baseInput, parentSession(), 'go', settings);
    expect(result.model).toBe('pi:legacy-model');
  });

  it('falls through when the map has no entry for the resolved provider', () => {
    const settings = fakeSettings({
      NUNCIO_SUBAGENT_MODELS: JSON.stringify({ codex: 'codex:mapped' }),
      NUNCIO_SUBAGENT_MODEL: 'pi:legacy-model',
    });
    const result = buildSubagentTaskInput(baseInput, parentSession({ provider: 'pi' }), 'go', settings);
    expect(result.model).toBe('pi:legacy-model');
  });

  it('lets an explicit input.model win over the map', () => {
    const settings = fakeSettings({ NUNCIO_SUBAGENT_MODELS: JSON.stringify({ pi: 'pi:mapped' }) });
    const result = buildSubagentTaskInput({ ...baseInput, model: 'pi:explicit' }, parentSession(), 'go', settings);
    expect(result.model).toBe('pi:explicit');
  });

  it('does NOT inherit parent modelOptions when the map supplied the model', () => {
    const settings = fakeSettings({ NUNCIO_SUBAGENT_MODELS: JSON.stringify({ pi: 'pi:mapped' }) });
    const result = buildSubagentTaskInput(baseInput, parentSession(), 'go', settings);
    expect(result.model).toBe('pi:mapped');
    expect(result.modelOptions).toBeUndefined();
  });

  it('still inherits parent modelOptions when nothing overrides the model', () => {
    const settings = fakeSettings({});
    const result = buildSubagentTaskInput(baseInput, parentSession(), 'go', settings);
    expect(result.model).toBe('pi:parent-model');
    expect(result.modelOptions).toEqual({ reasoningEffort: 'high' });
  });
});
