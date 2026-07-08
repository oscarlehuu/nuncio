import { describe, it, expect } from 'vitest';
import {
  parseSubagentModelMap,
  serializeSubagentModelMap,
  setSubagentModel,
} from './subagent-model-map';

describe('subagent model map serialization', () => {
  it('parses a stored JSON map', () => {
    expect(parseSubagentModelMap('{"pi":"claude-fable-5","codex":"gpt-5.5"}')).toEqual({
      pi: 'claude-fable-5',
      codex: 'gpt-5.5',
    });
  });

  it('treats null / blank / malformed input as an empty map', () => {
    expect(parseSubagentModelMap(null)).toEqual({});
    expect(parseSubagentModelMap('')).toEqual({});
    expect(parseSubagentModelMap('not json')).toEqual({});
    expect(parseSubagentModelMap('[1,2]')).toEqual({});
  });

  it('drops non-string and blank model ids on parse', () => {
    expect(parseSubagentModelMap('{"pi":"", "codex":123, "cursor":"x"}')).toEqual({ cursor: 'x' });
  });

  it('sets a provider model and clears it with a blank selection', () => {
    const base = { pi: 'claude-fable-5' };
    expect(setSubagentModel(base, 'codex', 'gpt-5.5')).toEqual({
      pi: 'claude-fable-5',
      codex: 'gpt-5.5',
    });
    expect(setSubagentModel(base, 'pi', '')).toEqual({});
    expect(setSubagentModel(base, 'pi', null)).toEqual({});
  });

  it('does not mutate the input map', () => {
    const base = { pi: 'claude-fable-5' };
    setSubagentModel(base, 'codex', 'gpt-5.5');
    expect(base).toEqual({ pi: 'claude-fable-5' });
  });

  it('serializes an empty map to an empty string (unset)', () => {
    expect(serializeSubagentModelMap({})).toBe('');
  });

  it('serializes with stable key order', () => {
    expect(serializeSubagentModelMap({ codex: 'gpt-5.5', pi: 'claude-fable-5' })).toBe(
      '{"codex":"gpt-5.5","pi":"claude-fable-5"}',
    );
  });

  it('round-trips a selection through set → serialize → parse', () => {
    const next = setSubagentModel({}, 'pi', 'claude-opus-4-8');
    expect(parseSubagentModelMap(serializeSubagentModelMap(next))).toEqual({ pi: 'claude-opus-4-8' });
  });
});
