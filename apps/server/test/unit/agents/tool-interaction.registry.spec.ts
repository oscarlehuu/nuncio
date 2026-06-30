import {
  getInteractionKind,
  isInteractiveTool,
} from '../../../src/agents/tool-interaction.registry';

describe('tool-interaction.registry', () => {
  it('maps known AskQuestion tool names to questionnaire (case-insensitive)', () => {
    for (const name of ['AskQuestion', 'askquestion', ' ASKQUESTION ', 'AskUserQuestion', 'askuserquestion', 'ask_question']) {
      expect(getInteractionKind(name)).toBe('questionnaire');
      expect(isInteractiveTool(name)).toBe(true);
    }
  });

  it('returns none for regular tools', () => {
    for (const tool of ['Read', 'bash', 'grep', 'Shell']) {
      expect(getInteractionKind(tool)).toBe('none');
      expect(isInteractiveTool(tool)).toBe(false);
    }
  });
});
