import { createHash } from 'node:crypto';

export const SPAWN_TASK_TOOL_NAME = 'spawn_task';
export const DISMISS_TASK_TOOL_NAME = 'dismiss_task';

/** Imperative title cap — long enough to name the work, short enough for a chip. */
export const MAX_TITLE_CHARS = 60;
/** One-to-two plain sentences. */
export const MAX_TLDR_CHARS = 400;
/**
 * A prompt shorter than this cannot be self-contained (paths + context), so it
 * is almost certainly a trivial inline fix that should just be done now, not
 * spun off. This is the machine half of the quality guard.
 */
export const MIN_PROMPT_CHARS = 40;
/** Keeps the whole chip event well under the 128 KB event-payload ceiling. */
export const MAX_PROMPT_CHARS = 8000;

export interface SpawnTaskInput {
  title: string;
  tldr: string;
  prompt: string;
  cwd?: string;
}

/**
 * Validate + normalize a raw `spawn_task` argument object at the boundary.
 * Returns the cleaned input, or an `{ error }` explaining the single first
 * violation (so the tool result / caller can echo one actionable message).
 * Character limits count code points (Array.from), not bytes, so a title of
 * 60 emoji is judged by what the user sees.
 */
export function normalizeSpawnTaskInput(
  input: unknown,
): { value: SpawnTaskInput } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'spawn_task requires an object with title, tldr and prompt.' };
  }
  const raw = input as Record<string, unknown>;
  const title = asTrimmedString(raw.title);
  const tldr = asTrimmedString(raw.tldr);
  const prompt = asTrimmedString(raw.prompt);
  const cwd = asTrimmedString(raw.cwd);

  if (!title) return { error: 'spawn_task title is required (imperative, one line).' };
  if (charLen(title) > MAX_TITLE_CHARS) {
    return { error: `spawn_task title must be ${MAX_TITLE_CHARS} characters or fewer.` };
  }
  if (!tldr) return { error: 'spawn_task tldr is required (1-2 plain sentences).' };
  if (charLen(tldr) > MAX_TLDR_CHARS) {
    return { error: `spawn_task tldr must be ${MAX_TLDR_CHARS} characters or fewer.` };
  }
  if (!prompt) return { error: 'spawn_task prompt is required.' };
  if (charLen(prompt) < MIN_PROMPT_CHARS) {
    return {
      error:
        'spawn_task prompt is too short to be self-contained — include file paths and enough context to act without this conversation, or just fix it inline now.',
    };
  }
  if (charLen(prompt) > MAX_PROMPT_CHARS) {
    return { error: `spawn_task prompt must be ${MAX_PROMPT_CHARS} characters or fewer.` };
  }
  return { value: { title, tldr, prompt, ...(cwd ? { cwd } : {}) } };
}

/**
 * Stable 8-char handle for a proposed chip, derived from its title + prompt.
 * Deterministic so the tool's echoed ref, the emitted event, and the server's
 * dedup key all agree WITHOUT sharing state — and so two identical proposals
 * from the same session collapse to one chip.
 */
export function spawnTaskRef(title: string, prompt: string): string {
  return createHash('sha256').update(`${title.trim()}\n${prompt.trim()}`).digest('hex').slice(0, 8);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function charLen(value: string): number {
  return Array.from(value).length;
}

const SPAWN_PARAMETERS = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: `Imperative one-line title, ${MAX_TITLE_CHARS} characters or fewer (e.g. "Remove the dead retry path in relay.ts").`,
    },
    tldr: {
      type: 'string',
      description: 'One to two plain sentences: what the follow-up is and why it is worth its own session.',
    },
    prompt: {
      type: 'string',
      description:
        'The self-contained brief for a FRESH agent that cannot see this conversation. Include exact file paths and enough context to act. If it is a few-line fix you could make right now, do that instead of spawning it.',
    },
    cwd: {
      type: 'string',
      description: 'Optional working directory for the spawned session; defaults to this session\'s.',
    },
  },
  required: ['title', 'tldr', 'prompt'],
};

const DISMISS_PARAMETERS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The ref returned when you proposed the chip with spawn_task.' },
    reason: { type: 'string', description: 'One line on why the chip is no longer worth spawning.' },
  },
  required: ['id'],
};

const SPAWN_DESCRIPTION =
  'Flag a genuinely out-of-scope, SUBSTANTIVE follow-up you noticed while working (dead code, stale docs, a missing test, a confirmed TODO, a security smell) as a one-tap chip — the user can spin it into its own session later while this turn continues uninterrupted. Do NOT use it for vague code smells, style nits, or anything you can fix inline in a few lines right now — just fix those. The prompt MUST be self-contained (file paths + context to act without this conversation).';

/**
 * The spawn-task tool. It only acknowledges; the provider turns the call into a
 * `spawn_task_proposed` session event, and the server materializes the durable,
 * deduped chip. The echoed ref lets a later dismiss_task target this chip.
 */
export function buildSpawnTaskTool(defineTool?: (tool: unknown) => unknown): unknown {
  const wrap = defineTool ?? ((tool: unknown) => tool);
  return wrap({
    name: SPAWN_TASK_TOOL_NAME,
    label: 'Spawn a follow-up task',
    description: SPAWN_DESCRIPTION,
    promptSnippet:
      'spawn_task: flag a substantive, self-contained out-of-scope follow-up as a one-tap chip (never for trivial inline fixes).',
    promptGuidelines: [
      'Only spawn work that deserves its own session; fix anything small inline instead.',
      'Write the prompt for an agent with no access to this conversation — include file paths and context.',
      'If later work makes a chip stale, withdraw it with dismiss_task using the ref you were given.',
    ],
    parameters: SPAWN_PARAMETERS,
    execute: async (_toolCallId: string, params: unknown) => {
      const normalized = normalizeSpawnTaskInput(params);
      if ('error' in normalized) {
        return {
          content: [{ type: 'text', text: `spawn_task ignored: ${normalized.error}` }],
          isError: true,
          details: {},
        };
      }
      const ref = spawnTaskRef(normalized.value.title, normalized.value.prompt);
      return {
        content: [
          {
            type: 'text',
            text: `Proposed follow-up chip "${normalized.value.title}" (ref: ${ref}). It is waiting for the user; keep working. To withdraw it, call dismiss_task with id "${ref}".`,
          },
        ],
        details: {},
      };
    },
  });
}

/** Companion tool: withdraw a chip that later work makes stale. */
export function buildDismissTaskTool(defineTool?: (tool: unknown) => unknown): unknown {
  const wrap = defineTool ?? ((tool: unknown) => tool);
  return wrap({
    name: DISMISS_TASK_TOOL_NAME,
    label: 'Dismiss a follow-up task',
    description:
      'Withdraw a spawn_task chip you proposed earlier this session once your own later work has made it unnecessary. Pass the ref you were given.',
    promptSnippet: 'dismiss_task: withdraw an earlier spawn_task chip that is now stale.',
    parameters: DISMISS_PARAMETERS,
    execute: async (_toolCallId: string, params: unknown) => {
      const id = asTrimmedString((params as { id?: unknown } | null)?.id);
      if (!id) {
        return {
          content: [{ type: 'text', text: 'dismiss_task ignored: an id (the chip ref) is required.' }],
          isError: true,
          details: {},
        };
      }
      return {
        content: [{ type: 'text', text: `Withdrew follow-up chip ${id}.` }],
        details: {},
      };
    },
  });
}
