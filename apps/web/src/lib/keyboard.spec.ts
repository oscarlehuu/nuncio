import { describe, expect, it } from 'vitest';
import { isComposingEvent } from './keyboard';

function event(overrides: { isComposing?: boolean; keyCode?: number }) {
  return {
    keyCode: overrides.keyCode ?? 13,
    nativeEvent: { isComposing: overrides.isComposing ?? false },
  } as unknown as Parameters<typeof isComposingEvent>[0];
}

describe('isComposingEvent', () => {
  it('is false for a normal Enter', () => {
    expect(isComposingEvent(event({}))).toBe(false);
  });

  it('is true while IME is composing', () => {
    expect(isComposingEvent(event({ isComposing: true }))).toBe(true);
  });

  it('is true for keyCode 229 even when isComposing is false', () => {
    expect(isComposingEvent(event({ keyCode: 229 }))).toBe(true);
  });
});
