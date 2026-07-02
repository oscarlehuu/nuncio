import { describe, it, expect } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('merges conflicting tailwind classes, keeping the last', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('joins non-conflicting classes', () => {
    expect(cn('flex', 'items-center', 'gap-2')).toBe('flex items-center gap-2');
  });

  it('handles conditional and falsy values', () => {
    const cond = false;
    expect(cn('base', cond && 'no', 'ok', undefined, null)).toBe('base ok');
  });

  it('treats the UI type scale as font-size, not text color', () => {
    // text-ui-xs must not evict a color utility…
    expect(cn('text-primary-foreground', 'text-ui-xs')).toBe('text-primary-foreground text-ui-xs');
    // …but must still replace a real font-size.
    expect(cn('text-sm', 'text-ui-lg')).toBe('text-ui-lg');
  });
});
