import { normalizeUserInput } from '../../sessions/domain/user-input.types';

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

const ASK_PARAMETERS = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short heading shown above the questions.' },
    questions: {
      type: 'array',
      description: 'One entry per question (max 4).',
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          header: { type: 'string', description: 'Very short chip label, e.g. "Storage".' },
          prompt: { type: 'string', description: 'The full question.' },
          allowMultiple: {
            type: 'boolean',
            description: 'Allow selecting several options at once.',
          },
          options: {
            type: 'array',
            description:
              'Choices in display order. They are shown to the user numbered 1, 2, 3, 4 by position — do not add your own numbering to labels.',
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Concise choice text (1-5 words).' },
                description: {
                  type: 'string',
                  description: 'One line on what this choice means or its trade-off.',
                },
              },
              required: ['label'],
            },
          },
        },
        required: ['prompt', 'options'],
      },
    },
  },
  required: ['questions'],
};

function exceedsQuestionLimits(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  let questions = (input as { questions?: unknown }).questions;
  if (typeof questions === 'string') {
    try {
      questions = JSON.parse(questions);
    } catch {
      return false;
    }
  }
  if (!Array.isArray(questions)) return false;
  if (questions.length > 4) return true;
  return questions.some((question) => {
    if (typeof question !== 'object' || question === null) return false;
    const options = (question as { options?: unknown }).options;
    return Array.isArray(options) && options.length > 4;
  });
}

function numberedEcho(input: unknown): string | undefined {
  const normalized = normalizeUserInput(ASK_USER_QUESTION_TOOL_NAME, input);
  if (!normalized) return undefined;
  return normalized.questions
    .map((question) => {
      const options = question.options
        .map((option, index) => `  ${index + 1}) ${option.label}`)
        .join('\n');
      return `${question.prompt}\n${options}`;
    })
    .join('\n');
}

/**
 * Interactive question tool. The provider surfaces the call as a
 * user_input_requested session event (numbered card in the nuncio UI) and the
 * user's answer comes back as the next user message — the tool result only
 * anchors the numbering in the model's context so replies like "option 2"
 * stay resolvable.
 */
export function buildAskUserQuestionTool(defineTool?: (tool: unknown) => unknown): unknown {
  const wrap = defineTool ?? ((tool: unknown) => tool);
  return wrap({
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: 'Ask the user',
    description:
      'Ask the user up to 4 structured questions when you are blocked on a decision only they can make. Options are shown numbered 1, 2, 3, 4 in the order you pass them; the user may answer by number ("option 2" or just "2") and may attach a free-text note to their choice. After calling this tool, end your turn — the answer arrives as the next user message.',
    promptSnippet:
      'AskUserQuestion: ask the user a structured question with numbered options (1-4); their reply may reference option numbers.',
    promptGuidelines: [
      'When the user replies with a bare number or "option N", it refers to the numbered options of your latest AskUserQuestion call.',
    ],
    parameters: ASK_PARAMETERS,
    execute: async (_toolCallId: string, params: unknown) => {
      if (exceedsQuestionLimits(params)) {
        return {
          content: [
            {
              type: 'text',
              text: 'AskUserQuestion ignored: use at most 4 questions and 4 options per question.',
            },
          ],
          isError: true,
          details: {},
        };
      }
      const echo = numberedEcho(params);
      if (!echo) {
        return {
          content: [
            {
              type: 'text',
              text: 'AskUserQuestion ignored: no usable questions (each needs a prompt and at least one option).',
            },
          ],
          isError: true,
          details: {},
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Question presented to the user with numbered options:\n${echo}\nWait for their reply — it arrives as the next user message, and bare numbers refer to these options.`,
          },
        ],
        details: {},
      };
    },
  });
}
