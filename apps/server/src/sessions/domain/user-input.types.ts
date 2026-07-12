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

function uniqueId(preferred: string, used: Set<string>): string {
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  let suffix = 2;
  while (used.has(`${preferred}-${suffix}`)) suffix += 1;
  const id = `${preferred}-${suffix}`;
  used.add(id);
  return id;
}

function normalizeOption(
  raw: unknown,
  index: number,
  usedIds: Set<string>,
): UserInputOption | undefined {
  if (!isRecord(raw)) return undefined;
  const label = typeof raw.label === 'string' ? raw.label : undefined;
  if (!label) return undefined;
  // Options are numbered by position everywhere (UI, formatted answers), so a
  // missing id defaults to that visible number.
  const preferredId = typeof raw.id === 'string' && raw.id ? raw.id : String(index + 1);
  const id = uniqueId(preferredId, usedIds);
  const description = typeof raw.description === 'string' ? raw.description : undefined;
  return description ? { id, label, description } : { id, label };
}

function normalizeQuestion(
  raw: unknown,
  index: number,
  usedIds: Set<string>,
): UserInputQuestion | undefined {
  if (!isRecord(raw)) return undefined;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : undefined;
  if (!prompt || !Array.isArray(raw.options)) return undefined;
  const optionIds = new Set<string>();
  const options = raw.options
    .map((option, optionIndex) => normalizeOption(option, optionIndex, optionIds))
    .filter((option): option is UserInputOption => option !== undefined);
  if (options.length === 0) return undefined;
  const preferredId = typeof raw.id === 'string' && raw.id ? raw.id : `q${index + 1}`;
  const id = uniqueId(preferredId, usedIds);

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

  const questionIds = new Set<string>();
  const questions = rawQuestions
    .map((question, index) => normalizeQuestion(question, index, questionIds))
    .filter((question): question is UserInputQuestion => question !== undefined);
  if (questions.length === 0) return undefined;

  const title = typeof input.title === 'string' ? input.title : undefined;
  return title ? { questions, title } : { questions };
}
