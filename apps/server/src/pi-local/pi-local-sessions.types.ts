export interface LocalPiSessionDto {
  sessionId: string;
  path: string;
  workspace: string;
  title: string;
  preview: string | null;
  updatedAt: number;
  messageCount: number;
  alreadyImported: boolean;
  nuncioSessionId?: string;
}
