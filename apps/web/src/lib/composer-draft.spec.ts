import { describe, it, expect, beforeEach } from 'vitest';
import { issueSessionPrompt, saveComposerDraft, takeComposerDraft } from './composer-draft';

describe('composer-draft', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('round-trips a draft exactly once', () => {
    saveComposerDraft({ prompt: 'Fix issue #9: crash', projectPath: '/repo' });
    expect(takeComposerDraft()).toEqual({ prompt: 'Fix issue #9: crash', projectPath: '/repo' });
    // take() clears — a reload must not resurrect the prefill.
    expect(takeComposerDraft()).toBeNull();
  });

  it('rejects empty or malformed drafts', () => {
    sessionStorage.setItem('nuncio-composer-draft', JSON.stringify({ prompt: '   ' }));
    expect(takeComposerDraft()).toBeNull();
    sessionStorage.setItem('nuncio-composer-draft', '{broken');
    expect(takeComposerDraft()).toBeNull();
  });

  it('issueSessionPrompt embeds title, body, url, and the auto-close keyword', () => {
    const prompt = issueSessionPrompt({
      number: 12,
      title: 'Crash on save',
      body: 'Steps to reproduce…',
      url: 'https://github.com/o/r/issues/12',
    });
    expect(prompt).toContain('Fix issue #12: Crash on save');
    expect(prompt).toContain('Steps to reproduce…');
    expect(prompt).toContain('Issue: https://github.com/o/r/issues/12');
    expect(prompt).toContain('Closes #12');
  });

  it('omits the body block when the issue body is empty', () => {
    const prompt = issueSessionPrompt({ number: 3, title: 'T', body: '  ', url: 'u' });
    expect(prompt).toBe('Fix issue #3: T\n\nIssue: u\nCloses #3');
  });
});
