export interface LocalCursorSessionDto {
  chatId: string;
  workspace: string;
  projectSlug: string;
  title: string;
  preview: string | null;
  updatedAt: number;
  messageCount: number;
  alreadyImported: boolean;
  nuncioSessionId?: string;
}
