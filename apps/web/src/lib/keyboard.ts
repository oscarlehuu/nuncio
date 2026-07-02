import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * True while an IME (Vietnamese Telex, Japanese, …) is composing — Enter then
 * commits the composition and must not submit the form. keyCode 229 covers
 * engines that fire the key event before isComposing is set.
 */
export function isComposingEvent(event: ReactKeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}
