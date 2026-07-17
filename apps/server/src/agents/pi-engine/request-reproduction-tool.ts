import { createHash } from 'node:crypto';

export const REQUEST_REPRODUCTION_TOOL_NAME = 'request_reproduction';

/** A gate with more than this many steps is noise, not a checklist. */
export const MAX_STEPS = 12;
/** One copy-pasteable command/instruction per step; longer is a paragraph, not a step. */
export const MAX_STEP_CHARS = 500;
/** A one-line pointer at where the useful logs will surface. */
export const MAX_LOGS_HINT_CHARS = 400;

export interface ReproductionRequestInput {
  /** Numbered, copy-pasteable steps the human runs to reproduce the failure. */
  steps: string[];
  /** Optional hint on which logs/output to watch for (file, stream, marker). */
  logsHint?: string;
}

/**
 * Validate + normalize a raw `request_reproduction` argument object at the
 * boundary. Returns the cleaned input, or an `{ error }` naming the single first
 * violation so the tool result echoes one actionable message. Character limits
 * count code points (Array.from), not bytes, so a step of emoji is judged by
 * what the user sees.
 */
export function normalizeReproductionInput(
  input: unknown,
): { value: ReproductionRequestInput } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'request_reproduction requires an object with a steps array.' };
  }
  const raw = input as Record<string, unknown>;

  const steps = coerceStringArray(raw.steps)
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
  if (steps.length === 0) {
    return {
      error: 'request_reproduction requires at least one non-empty step (numbered, copy-pasteable).',
    };
  }
  if (steps.length > MAX_STEPS) {
    return { error: `request_reproduction accepts at most ${MAX_STEPS} steps.` };
  }
  const overlong = steps.find((step) => charLen(step) > MAX_STEP_CHARS);
  if (overlong) {
    return { error: `each request_reproduction step must be ${MAX_STEP_CHARS} characters or fewer.` };
  }

  const logsHint = asTrimmedString(raw.logsHint);
  if (logsHint && charLen(logsHint) > MAX_LOGS_HINT_CHARS) {
    return { error: `request_reproduction logsHint must be ${MAX_LOGS_HINT_CHARS} characters or fewer.` };
  }

  return { value: { steps, ...(logsHint ? { logsHint } : {}) } };
}

/**
 * Stable 8-char handle for a reproduction gate. Derived from the session id plus
 * a monotonic nonce so EACH request (a fresh debug cycle) gets its own gate:
 * resolving one cycle's gate must never suppress the next cycle's on the same
 * session. The nonce keeps two identical step lists in the same session distinct.
 */
export function reproductionGateRef(sessionId: string, nonce: string): string {
  return createHash('sha256').update(`${sessionId}\n${nonce}`).digest('hex').slice(0, 8);
}

function coerceStringArray(value: unknown): string[] {
  let candidate = value;
  // Pi occasionally hands array args as a JSON string; parse before validating.
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((entry): entry is string => typeof entry === 'string');
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function charLen(value: string): number {
  return Array.from(value).length;
}

const REPRODUCTION_PARAMETERS = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      description:
        `Numbered, copy-pasteable steps the user runs to reproduce the failure while your ` +
        `instrumentation collects logs (max ${MAX_STEPS}). Do NOT number them yourself — they are ` +
        `shown numbered by position. Each step is one command or one concrete instruction.`,
      maxItems: MAX_STEPS,
      items: { type: 'string' },
    },
    logsHint: {
      type: 'string',
      description:
        'Optional one line on which logs/output to watch for (file path, stream, or the marker your instrumentation prints).',
    },
  },
  required: ['steps'],
};

const REPRODUCTION_DESCRIPTION =
  'Pause the run and ask the user to reproduce the failure while your instrumentation collects evidence. ' +
  'Use this in Debug mode ONLY after you have enumerated hypotheses and added marked (// nuncio-debug) log lines — never to skip diagnosis. ' +
  'The user gets a "Reproduction Steps" gate with your numbered steps, a live log counter, and two choices: ' +
  'Proceed (they ran it — you continue with the collected logs) or Mark Fixed (they confirmed the fix works — you strip your instrumentation). ' +
  'After calling this tool, END your turn and wait; the gate resolves as the next user message.';

/**
 * The request_reproduction tool. It only acknowledges; the provider turns the
 * call into a `reproduce_requested` session event, and the server materializes
 * the durable, one-tap reproduction gate. The agent must end its turn after
 * calling it (the gate is a human-in-the-loop pause).
 */
export function buildRequestReproductionTool(defineTool?: (tool: unknown) => unknown): unknown {
  const wrap = defineTool ?? ((tool: unknown) => tool);
  return wrap({
    name: REQUEST_REPRODUCTION_TOOL_NAME,
    label: 'Request a reproduction',
    description: REPRODUCTION_DESCRIPTION,
    promptSnippet:
      'request_reproduction: pause for the user to reproduce the bug while your marked instrumentation collects logs; end your turn after calling it.',
    promptGuidelines: [
      'Only call this after hypotheses are enumerated and // nuncio-debug instrumentation is in place.',
      'Give copy-pasteable steps; do not number them yourself — they are shown numbered by position.',
      'End your turn immediately after calling it. Continue when the user chooses Proceed or Mark Fixed.',
    ],
    parameters: REPRODUCTION_PARAMETERS,
    execute: async (_toolCallId: string, params: unknown) => {
      const normalized = normalizeReproductionInput(params);
      if ('error' in normalized) {
        return {
          content: [{ type: 'text', text: `request_reproduction ignored: ${normalized.error}` }],
          isError: true,
          details: {},
        };
      }
      const stepCount = normalized.value.steps.length;
      return {
        content: [
          {
            type: 'text',
            text:
              `Reproduction gate presented to the user with ${stepCount} step${stepCount === 1 ? '' : 's'}. ` +
              'Wait for them: "Proceed" returns the collected logs as the next user message; "Mark Fixed" tells you to remove your // nuncio-debug instrumentation. End your turn now.',
          },
        ],
        details: {},
      };
    },
  });
}
