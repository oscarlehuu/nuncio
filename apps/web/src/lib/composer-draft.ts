// One-shot handoff of a prefilled prompt into the home composer (e.g.
// "Start session from issue"). sessionStorage keeps it tab-local and
// non-persistent; take() clears it so a draft never resurfaces later.

const COMPOSER_DRAFT_KEY = 'nuncio-composer-draft';

export interface ComposerDraft {
  prompt: string;
  projectPath?: string;
}

export function saveComposerDraft(draft: ComposerDraft, storage: Storage = sessionStorage): void {
  try {
    storage.setItem(COMPOSER_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Best-effort: a blocked storage only loses the prefill, not the flow.
  }
}

export function takeComposerDraft(storage: Storage = sessionStorage): ComposerDraft | null {
  try {
    const raw = storage.getItem(COMPOSER_DRAFT_KEY);
    if (!raw) return null;
    storage.removeItem(COMPOSER_DRAFT_KEY);
    const parsed = JSON.parse(raw) as Partial<ComposerDraft>;
    if (typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) return null;
    return {
      prompt: parsed.prompt,
      projectPath: typeof parsed.projectPath === 'string' ? parsed.projectPath : undefined,
    };
  } catch {
    return null;
  }
}

export function issueSessionPrompt(issue: {
  number: number;
  title: string;
  body: string;
  url: string;
}): string {
  const body = issue.body.trim() ? `\n\n${issue.body.trim()}` : '';
  // The PR body defaults to the session prompt, so "Closes #n" here makes the
  // forge auto-close the issue when the PR merges (GitHub and GitLab keyword).
  return `Fix issue #${issue.number}: ${issue.title}${body}\n\nIssue: ${issue.url}\nCloses #${issue.number}`;
}
