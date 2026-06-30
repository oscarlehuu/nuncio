export type InteractionKind = 'questionnaire' | 'none';

const INTERACTIVE_TOOLS: Record<string, InteractionKind> = {
  askquestion: 'questionnaire',
  askuserquestion: 'questionnaire',
  ask_question: 'questionnaire',
};

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

export function getInteractionKind(toolName: string): InteractionKind {
  return INTERACTIVE_TOOLS[normalizeToolName(toolName)] ?? 'none';
}

export function isInteractiveTool(toolName: string): boolean {
  return getInteractionKind(toolName) !== 'none';
}
