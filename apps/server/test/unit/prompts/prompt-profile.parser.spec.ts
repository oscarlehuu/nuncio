import { parseProfileDocument } from '../../../src/prompts/prompt-profile.parser';

const FULL = `---
provider: claude
modelPattern: "opus-*"
version: 3
status: active
contextFileName: CLAUDE.local.md
evalScore: { passRate: 0.88 }
---

## brief-wrapper
Wrapped brief: {{content}}

## facts-wrapper
FACTS-> {{content}}

## digest-wrapper
{{content}} <-digest

## tools-preamble
Custom tools note.

## idioms
Some human notes.
`;

describe('parseProfileDocument', () => {
  it('parses frontmatter and named sections', () => {
    const warnings: string[] = [];
    const profile = parseProfileDocument(FULL, (w) => warnings.push(w));
    expect(profile).not.toBeNull();
    expect(profile!.provider).toBe('claude');
    expect(profile!.modelPattern).toBe('opus-*');
    expect(profile!.version).toBe(3);
    expect(profile!.status).toBe('active');
    expect(profile!.contextFileName).toBe('CLAUDE.local.md');
    expect(profile!.sections.briefWrapper).toBe('Wrapped brief: {{content}}');
    expect(profile!.sections.factsWrapper).toBe('FACTS-> {{content}}');
    expect(profile!.sections.digestWrapper).toBe('{{content}} <-digest');
    expect(profile!.sections.toolsPreamble).toBe('Custom tools note.');
    expect(profile!.sections.idioms).toBe('Some human notes.');
    expect(warnings).toHaveLength(0);
  });

  it('defaults modelPattern to * and status to draft/active sensibly', () => {
    const p = parseProfileDocument(`---\nprovider: pi\nversion: 1\n---\n`, () => {});
    expect(p!.provider).toBe('pi');
    expect(p!.modelPattern).toBe('*');
    expect(p!.version).toBe(1);
  });

  it('returns null (skip) with a warning on missing frontmatter', () => {
    const warnings: string[] = [];
    expect(parseProfileDocument('no frontmatter here', (w) => warnings.push(w))).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('returns null with a warning on an unterminated frontmatter block', () => {
    const warnings: string[] = [];
    expect(parseProfileDocument('---\nprovider: x\n(no close)', (w) => warnings.push(w))).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('returns null with a warning when provider is missing', () => {
    const warnings: string[] = [];
    expect(parseProfileDocument('---\nversion: 1\n---\n', (w) => warnings.push(w))).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('warns (does not fail) on an unknown section', () => {
    const warnings: string[] = [];
    const p = parseProfileDocument('---\nprovider: pi\n---\n\n## made-up-section\nx\n', (w) => warnings.push(w));
    expect(p).not.toBeNull();
    expect(warnings.some((w) => w.includes('made-up-section'))).toBe(true);
  });

  it('treats a non-integer version as the default', () => {
    const p = parseProfileDocument('---\nprovider: pi\nversion: not-a-number\n---\n', () => {});
    expect(p!.version).toBe(1);
  });

  it.each(['../x', 'a/b.md', '/etc/passwd'])(
    'drops a non-bare contextFileName (%s) with one warning, keeping the profile',
    (name) => {
      const warnings: string[] = [];
      const p = parseProfileDocument(
        `---\nprovider: pi\ncontextFileName: ${name}\n---\n`,
        (w) => warnings.push(w),
      );
      expect(p).not.toBeNull();
      expect(p!.contextFileName).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(name);
    },
  );

  it('drops a section over 2048 serialized bytes with one warning; siblings survive', () => {
    const warnings: string[] = [];
    const doc = `---\nprovider: pi\n---\n\n## digest-wrapper\n${'x'.repeat(3000)}\n\n## brief-wrapper\nsmall {{content}}\n`;
    const p = parseProfileDocument(doc, (w) => warnings.push(w));
    expect(p).not.toBeNull();
    expect(p!.sections.digestWrapper).toBeUndefined();
    expect(p!.sections.briefWrapper).toBe('small {{content}}');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('digest-wrapper');
  });

  it('keeps a section at exactly the 2048-byte ceiling', () => {
    const warnings: string[] = [];
    const body = 'y'.repeat(2048);
    const p = parseProfileDocument(`---\nprovider: pi\n---\n\n## idioms\n${body}\n`, (w) => warnings.push(w));
    expect(p!.sections.idioms).toBe(body);
    expect(warnings).toHaveLength(0);
  });

  it('keeps a valid bare contextFileName', () => {
    const warnings: string[] = [];
    const p = parseProfileDocument(
      '---\nprovider: pi\ncontextFileName: CLAUDE.local.md\n---\n',
      (w) => warnings.push(w),
    );
    expect(p!.contextFileName).toBe('CLAUDE.local.md');
    expect(warnings).toHaveLength(0);
  });

  it('parses a CRLF document identically to its LF twin', () => {
    const warnings: string[] = [];
    const crlf = FULL.replace(/\n/g, '\r\n');
    const parsed = parseProfileDocument(crlf, (w) => warnings.push(w));
    expect(parsed).toEqual(parseProfileDocument(FULL, () => {}));
    expect(warnings).toHaveLength(0);
  });

  it('parses a lone-CR document identically to its LF twin', () => {
    const warnings: string[] = [];
    const cr = FULL.replace(/\n/g, '\r');
    const parsed = parseProfileDocument(cr, (w) => warnings.push(w));
    expect(parsed).toEqual(parseProfileDocument(FULL, () => {}));
    expect(warnings).toHaveLength(0);
  });
});
