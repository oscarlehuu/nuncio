import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptProfileLoader } from '../../../src/prompts/prompt-profile.loader';
import { EMPTY_PROFILE } from '../../../src/prompts/prompt-profile.types';

function writeProfile(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), body);
}

describe('PromptProfileLoader', () => {
  let dir: string;
  let settings: Map<string, string>;
  let loader: PromptProfileLoader;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuncio-profiles-'));
    settings = new Map();
    loader = new PromptProfileLoader(dir, (key) => settings.get(key));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the empty pass-through profile when nothing matches', () => {
    expect(loader.resolve('claude', 'opus')).toEqual(EMPTY_PROFILE);
  });

  it('uses the provider repo file', () => {
    writeProfile(dir, 'claude.md', '---\nprovider: claude\n---\n\n## brief-wrapper\nP: {{content}}\n');
    expect(loader.resolve('claude', 'opus').sections.briefWrapper).toBe('P: {{content}}');
  });

  it('prefers a model-specific repo file over the provider file', () => {
    writeProfile(dir, 'claude.md', '---\nprovider: claude\n---\n\n## brief-wrapper\nprovider\n');
    writeProfile(dir, 'claude--opus.md', '---\nprovider: claude\nmodelPattern: "opus*"\n---\n\n## brief-wrapper\nmodel\n');
    expect(loader.resolve('claude', 'opus').sections.briefWrapper).toBe('model');
    // A different model falls back to the provider file.
    expect(loader.resolve('claude', 'sonnet').sections.briefWrapper).toBe('provider');
  });

  it('the most-specific modelPattern glob wins', () => {
    writeProfile(dir, 'claude--any.md', '---\nprovider: claude\nmodelPattern: "*"\n---\n\n## brief-wrapper\nstar\n');
    writeProfile(dir, 'claude--opus.md', '---\nprovider: claude\nmodelPattern: "opus-*"\n---\n\n## brief-wrapper\nspecific\n');
    expect(loader.resolve('claude', 'opus-4').sections.briefWrapper).toBe('specific');
  });

  it('a DB override wins over every repo file', () => {
    writeProfile(dir, 'claude.md', '---\nprovider: claude\n---\n\n## brief-wrapper\nrepo\n');
    settings.set('NUNCIO_PROMPT_PROFILE_CLAUDE', '---\nprovider: claude\n---\n\n## brief-wrapper\ndb\n');
    expect(loader.resolve('claude', 'opus').sections.briefWrapper).toBe('db');
  });

  it('skips a malformed repo file and falls through', () => {
    const warnings: string[] = [];
    loader = new PromptProfileLoader(dir, () => undefined, (w) => warnings.push(w));
    writeProfile(dir, 'claude.md', 'no frontmatter');
    expect(loader.resolve('claude', 'opus')).toEqual(EMPTY_PROFILE);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('caches and bustCache re-reads the file', () => {
    writeProfile(dir, 'claude.md', '---\nprovider: claude\n---\n\n## brief-wrapper\nv1\n');
    expect(loader.resolve('claude', 'opus').sections.briefWrapper).toBe('v1');
    writeProfile(dir, 'claude.md', '---\nprovider: claude\n---\n\n## brief-wrapper\nv2\n');
    // Still cached.
    expect(loader.resolve('claude', 'opus').sections.briefWrapper).toBe('v1');
    loader.bustCache();
    expect(loader.resolve('claude', 'opus').sections.briefWrapper).toBe('v2');
  });

  it('equal-specificity glob ties resolve to the lexicographically-first file', () => {
    // Both patterns have specificity 6 and match 'opus-4'. The lexicographically
    // LATER file is written first so raw readdir/insertion order would pick it.
    writeProfile(dir, 'claude--bb.md', '---\nprovider: claude\nmodelPattern: "op*s-4"\n---\n\n## brief-wrapper\nBB\n');
    writeProfile(dir, 'claude--aa.md', '---\nprovider: claude\nmodelPattern: "opu*-4"\n---\n\n## brief-wrapper\nAA\n');
    expect(loader.resolve('claude', 'opus-4').sections.briefWrapper).toBe('AA');

    // Reversed write order in a fresh dir → the same deterministic winner.
    const dir2 = mkdtempSync(join(tmpdir(), 'nuncio-profiles-'));
    try {
      const loader2 = new PromptProfileLoader(dir2, () => undefined);
      writeProfile(dir2, 'claude--aa.md', '---\nprovider: claude\nmodelPattern: "opu*-4"\n---\n\n## brief-wrapper\nAA\n');
      writeProfile(dir2, 'claude--bb.md', '---\nprovider: claude\nmodelPattern: "op*s-4"\n---\n\n## brief-wrapper\nBB\n');
      expect(loader2.resolve('claude', 'opus-4').sections.briefWrapper).toBe('AA');
      loader2.bustCache();
      expect(loader2.resolve('claude', 'opus-4').sections.briefWrapper).toBe('AA');
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('a null/undefined model resolves against the wildcard', () => {
    writeProfile(dir, 'claude.md', '---\nprovider: claude\n---\n\n## brief-wrapper\nok\n');
    expect(loader.resolve('claude', null).sections.briefWrapper).toBe('ok');
  });
});
