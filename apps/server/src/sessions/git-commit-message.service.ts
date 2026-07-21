import { BadRequestException, Injectable } from '@nestjs/common';
import { AgentRegistry } from '../agents/agents.registry';
import { GitService } from '../git/git.service';
import { truncateHeadBytes } from '../orchestration/byte-truncate';

/** Bound the patch fed to the completion so a huge diff can't blow the prompt. */
const DIFF_PROMPT_MAX_BYTES = 24 * 1024;
const COMPLETION_TIMEOUT_MS = 60_000;

const COMMIT_MESSAGE_SYSTEM_PROMPT =
  'You write git commit messages. Given a working-tree status and diff, return ONLY the commit ' +
  'message text — no prose, no code fence, no quotes. Use the conventional-commit style ' +
  '(feat:/fix:/docs:/chore:/refactor:), a summary line under 72 characters, and add a short ' +
  'body only when the change genuinely needs one.';

/**
 * One-shot commit-message generation over the session's working tree. Routes
 * through `AgentProvider.completeOneShot` (same seam as fact distillation) —
 * Nuncio never calls a model API directly; the engine's tool-less throwaway
 * session does the writing.
 */
@Injectable()
export class GitCommitMessageService {
  constructor(
    private readonly git: GitService,
    private readonly agents: AgentRegistry,
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

    const diff = await this.git.diff(workingDir, {});
    const fileList = status.files
      .map((file) => `${(file.index + file.workTree).trim() || 'M'} ${file.path}`)
      .join('\n');
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
        systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
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
