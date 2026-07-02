import { describe, expect, it } from 'vitest';
import { formatHex } from 'culori';
import { darkTokens, lightTokens } from '@nuncio/core/design-tokens';
import generated from '../../tailwind-colors';

describe('tailwind-colors stays in parity with @nuncio/core design tokens', () => {
  it('every generated color equals the oklch token converted to hex', () => {
    for (const [scheme, tokens] of [
      ['light', lightTokens],
      ['dark', darkTokens],
    ] as const) {
      for (const [key, hex] of Object.entries(generated[scheme])) {
        expect(tokens[key], `${scheme}.${key} missing in core tokens`).toBeDefined();
        expect(hex, `${scheme}.${key}`).toBe(formatHex(tokens[key]));
      }
    }
  });

  it('covers the semantic palette the app styles with', () => {
    for (const key of ['background', 'foreground', 'primary', 'muted-foreground', 'border', 'destructive']) {
      expect(generated.dark[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('radius matches the core token', () => {
    expect(generated.radius).toBe(lightTokens.radius);
  });
});
