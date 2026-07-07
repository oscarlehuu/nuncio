import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ADR-004: per-engine prompt shape lives ONLY in prompt profiles + the compose
// layer; provider adapters receive finished strings and must never touch a
// profile. A grep-level guard: no provider adapter imports the profile modules.
describe('provider adapters never access prompt profiles (ADR-004)', () => {
  const providersDir = join(__dirname, '../../../src/agents/providers');

  it('no file under src/agents/providers references prompt-profile', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(providersDir)) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(join(providersDir, file), 'utf8');
      if (/prompt-profile|PromptProfile|profile\.sections|briefWrapper|factsWrapper|digestWrapper/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
