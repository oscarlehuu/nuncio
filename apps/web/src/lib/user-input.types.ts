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

export type UserInputResolvedBy = 'user' | 'timeout' | 'skip' | 'provider';

export interface PendingUserInput {
  requestId: string;
  createdAt: number;
  title?: string;
  questions: UserInputQuestion[];
}

export interface UserInputAnswer {
  questionId: string;
  selectedOptionIds: string[];
  freeText?: string;
}

export interface InteractionResponse {
  answers: UserInputAnswer[];
  resolvedBy: 'user' | 'skip';
}
