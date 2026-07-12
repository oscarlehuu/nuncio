import { isInteractiveTool } from '../../agents/tool-interaction.registry';

export interface UserInputOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  id: string;
  header?: string;
  prompt: string;
  options: UserInputOption[];
  allowMultiple?: boolean;
}

/** Future live-respond path — answers stored inline on user_input_resolved. */
export interface UserInputAnswer {
  questionId: string;
  selectedOptionIds: string[];
  freeText?: string;
}

export interface NormalizedUserInput {
  questions: UserInputQuestion[];
  title?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeOption(raw: unknown, index: number): UserInputOption | undefined {
  if (!isRecord(raw)) return undefined;
  const label = typeof raw.label === 'string' ? raw.label : undefined;
  if (!label) return undefined;
  // Options are numbered by position everywhere (UI, formatted answers), so a
  // missing id defaults to that visible number.
  const id = typeof raw.id === 'string' && raw.id ? raw.id : String(index + 1);
  const description = typeof raw.description === 'string' ? raw.description : undefined;
  return description ? { id, label, description } : { id, label };
}

function normalizeQuestion(raw: unknown, index: number): UserInputQuestion | undefined {
  if (!isRecord(raw)) return undefined;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : undefined;
  if (!prompt || !Array.isArray(raw.options)) return undefined;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `q${index + 1}`;

  const options = raw.options
    .map((option, optionIndex) => normalizeOption(option, optionIndex))
    .filter((option): option is UserInputOption => option !== undefined);
  if (options.length === 0) return undefined;

  const header = typeof raw.header === 'string' ? raw.header : undefined;
  const allowMultiple = typeof raw.allowMultiple === 'boolean' ? raw.allowMultiple : undefined;

  return {
    id,
    prompt,
    options,
    ...(header ? { header } : {}),
    ...(allowMultiple !== undefined ? { allowMultiple } : {}),
  };
}

function parseQuestionsField(value: unknown): unknown[] | undefined {
  let questions = value;
  if (typeof questions === 'string') {
    try {
      questions = JSON.parse(questions);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  return questions;
}

export function normalizeUserInput(
  tool: string,
  input: unknown,
): NormalizedUserInput | undefined {
  if (!isInteractiveTool(tool) || !isRecord(input)) return undefined;

  const rawQuestions = parseQuestionsField(input.questions);
  if (!rawQuestions) return undefined;

  const questions = rawQuestions
    .map(normalizeQuestion)
    .filter((question): question is UserInputQuestion => question !== undefined);
  if (questions.length === 0) return undefined;

  const title = typeof input.title === 'string' ? input.title : undefined;
  return title ? { questions, title } : { questions };
}
