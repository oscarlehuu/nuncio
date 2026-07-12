import { describe, expect, it } from 'bun:test';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  buildAskUserQuestionTool,
} from '../../../src/agents/pi-engine/ask-user-question-tool';

type AskTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
};

describe('pi-engine AskUserQuestion tool', () => {
  it('echoes numbered options so the model can resolve numeric replies', async () => {
    const tool = buildAskUserQuestionTool() as AskTool;
    expect(tool.name).toBe(ASK_USER_QUESTION_TOOL_NAME);
    expect(tool.description).toContain('numbered 1, 2, 3, 4');

    const result = await tool.execute('c1', {
      questions: [
        {
          prompt: 'Which lane?',
          options: [{ label: 'Frontend' }, { label: 'Backend', description: 'API work' }],
        },
      ],
    });
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBeUndefined();
    expect(text).toContain('Which lane?');
    expect(text).toContain('1) Frontend');
    expect(text).toContain('2) Backend');
    expect(text).toContain('next user message');
  });

  it('errors on unusable input', async () => {
    const tool = buildAskUserQuestionTool() as AskTool;
    const result = await tool.execute('c2', { questions: [{ prompt: 'No options', options: [] }] });
    expect(result.isError).toBe(true);
  });

  it('declares and enforces the advertised four-question and four-option limits', async () => {
    const tool = buildAskUserQuestionTool() as AskTool;
    const parameters = tool.parameters as {
      properties: {
        questions: {
          maxItems?: number;
          items: { properties: { options: { maxItems?: number } } };
        };
      };
    };
    expect(parameters.properties.questions.maxItems).toBe(4);
    expect(parameters.properties.questions.items.properties.options.maxItems).toBe(4);

    const result = await tool.execute('call-over-limit', {
      questions: Array.from({ length: 5 }, (_, questionIndex) => ({
        prompt: `Question ${questionIndex + 1}`,
        options: Array.from({ length: 5 }, (_, optionIndex) => ({
          label: `Option ${optionIndex + 1}`,
        })),
      })),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('at most 4 questions');
  });
});
