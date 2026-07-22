import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { AgentRegistry } from '../agents/agents.registry';
import type { AgentProvider } from '../agents/agents.types';
import { GitService } from '../git/git.service';
import { truncateHeadBytes } from '../orchestration/byte-truncate';
import { SettingsService } from '../settings/settings.service';

/** Bound the patch fed to the completion so a huge diff can't blow the prompt. */
const DIFF_PROMPT_MAX_BYTES = 24 * 1024;
const FILE_LIST_PROMPT_MAX_BYTES = 4 * 1024;
const SUBJECTS_PROMPT_MAX_BYTES = 4 * 1024;
const COMPLETION_TIMEOUT_MS = 60_000;

export const COMMIT_MESSAGE_MODEL_SETTING = 'NUNCIO_COMMIT_MESSAGE_MODEL';
export const COMMIT_MESSAGE_INSTRUCTION_SETTING = 'NUNCIO_COMMIT_MESSAGE_INSTRUCTION';

/** Learning needs enough real history to say anything useful about style. */
const MIN_HISTORY_FOR_LEARNING = 5;
const HISTORY_LIMIT = 50;
const LEARNED_INSTRUCTION_MAX_CHARS = 1000;

/** The fixed output contract; style comes from the instruction below it. */
const COMMIT_MESSAGE_CONTRACT =
  'You write git commit messages. Given a working-tree status and diff, return ONLY the commit ' +
  'message text — no prose, no code fence, no quotes.';

/** Built-in style used until an instruction is configured or learned. */
const DEFAULT_STYLE_INSTRUCTION =
  'Use the conventional-commit style (feat:/fix:/docs:/chore:/refactor:), a summary line under ' +
  '72 characters, and add a short body only when the change genuinely needs one.';

const LEARN_STYLE_SYSTEM_PROMPT =
  "You analyze a repository's recent git commit subjects and write a reusable style " +
  'instruction for future commit messages: describe the format, prefixes/scopes, mood/tense, ' +
  'capitalization, and typical length in under 600 characters. Return ONLY the instruction ' +
  'text — no prose, no code fence.';

/**
 * One-shot commit-message generation over the session's working tree. Routes
 * through `AgentProvider.completeOneShot` (same seam as fact distillation) —
 * Nuncio never calls a model API directly; the engine's tool-less throwaway
 * session does the writing.
 *
 * Style resolution: the `NUNCIO_COMMIT_MESSAGE_INSTRUCTION` setting wins when
 * set. When empty, the service learns an instruction once from the repo's
 * recent commit subjects, persists it into that same setting (so the user can
 * review and edit it in Settings), and uses it from then on. Model override
 * via `NUNCIO_COMMIT_MESSAGE_MODEL` (provider:modelId), engine default when
 * unset.
 */
@Injectable()
export class GitCommitMessageService {
  constructor(
    private readonly git: GitService,
    private readonly agents: AgentRegistry,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  async generate(workingDir: string): Promise<{ message: string }> {
    const status = await this.git.status(workingDir);
    if (!status.files.length) {
      throw new BadRequestException('Nothing to commit — the working tree is clean.');
    }

    const provider = (await this.agents.available()).find((p) => p.completeOneShot);
    if (!provider?.completeOneShot) {
      throw new BadRequestException(
        'No available engine supports text generation — sign in to an engine that does (e.g. Nuncio Engine).',
      );
    }

    const model = this.settings?.resolve(COMMIT_MESSAGE_MODEL_SETTING)?.trim() || null;
    const instruction = await this.resolveInstruction(provider, workingDir, model);

    // Diff against HEAD so already-staged changes are described too — the
    // commit stages everything, so the prompt must see everything. A repo with
    // no commits yet has no HEAD; fall back to the unstaged diff there.
    const diff = await this.git
      .diff(workingDir, { base: 'HEAD' })
      .catch(() => this.git.diff(workingDir, {}));
    const fileList = truncateHeadBytes(
      status.files
        .map((file) => `${(file.index + file.workTree).trim() || 'M'} ${file.path}`)
        .join('\n'),
      FILE_LIST_PROMPT_MAX_BYTES,
    );
    const prompt = [
      'Changed files:',
      fileList,
      '',
      'Diff:',
      truncateHeadBytes(diff.diff, DIFF_PROMPT_MAX_BYTES),
    ].join('\n');

    const raw = await withTimeout(
      provider.completeOneShot({
        prompt,
        systemPrompt: `${COMMIT_MESSAGE_CONTRACT}\n\nStyle instruction:\n${instruction}`,
        model,
        cwd: workingDir,
      }),
      COMPLETION_TIMEOUT_MS,
    );

    const message = cleanCompletion(raw);
    if (!message) {
      throw new BadRequestException('The engine returned an empty commit message — try again.');
    }
    return { message };
  }

  /**
   * User instruction > learned-and-persisted instruction > built-in default.
   * Learning is best-effort: any failure (thin history, engine error, empty
   * output) silently falls back to the default and persists nothing.
   */
  private async resolveInstruction(
    provider: AgentProvider,
    workingDir: string,
    model: string | null,
  ): Promise<string> {
    const configured = this.settings?.resolve(COMMIT_MESSAGE_INSTRUCTION_SETTING)?.trim();
    if (configured) return configured;

    try {
      const history = await this.git.history(workingDir, { limit: HISTORY_LIMIT });
      const subjects = history.commits.map((commit) => commit.subject).filter(Boolean);
      if (subjects.length < MIN_HISTORY_FOR_LEARNING) return DEFAULT_STYLE_INSTRUCTION;

      const raw = await withTimeout(
        provider.completeOneShot!({
          prompt: `Recent commit subjects from this repository:\n${truncateHeadBytes(subjects.join('\n'), SUBJECTS_PROMPT_MAX_BYTES)}`,
          systemPrompt: LEARN_STYLE_SYSTEM_PROMPT,
          model,
          cwd: workingDir,
        }),
        COMPLETION_TIMEOUT_MS,
      );
      const learned = cleanCompletion(raw).slice(0, LEARNED_INSTRUCTION_MAX_CHARS).trim();
      if (!learned) return DEFAULT_STYLE_INSTRUCTION;

      this.settings?.set(COMMIT_MESSAGE_INSTRUCTION_SETTING, learned);
      return learned;
    } catch {
      return DEFAULT_STYLE_INSTRUCTION;
    }
  }
}

/** Strip code fences and wrapping quotes the model may add despite instructions. */
function cleanCompletion(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1]!.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new BadRequestException(`Commit-message generation timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer!)) as Promise<T>;
}
