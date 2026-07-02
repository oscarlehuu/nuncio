import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { darkTokens, lightTokens } from './design-tokens';

const cssPath = new URL('../../../apps/web/src/index.css', import.meta.url);

function cssBlock(css: string, selector: string): Record<string, string> {
  const match = css.match(new RegExp(selector.replace('.', '\\.') + '\\s*\\{([^}]*)\\}'));
  if (!match) throw new Error(`selector ${selector} not found in index.css`);
  const vars: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/--([a-z0-9-]+):\s*(.+);/i);
    if (m) vars[m[1]] = m[2].trim();
  }
  return vars;
}

describe('design tokens stay in sync with apps/web index.css', () => {
  const css = readFileSync(cssPath, 'utf8');

  it('light tokens match :root', () => {
    expect(lightTokens).toEqual(cssBlock(css, ':root'));
  });

  it('dark tokens match .dark', () => {
    expect(darkTokens).toEqual(cssBlock(css, '.dark'));
  });
});
