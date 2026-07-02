export interface BrowserStateDto {
  connected: boolean;
  url: string | null;
  title: string | null;
  loading: boolean;
  screenshotVersion: number;
}

export type BrowserInputDto =
  | { type: 'click'; x: number; y: number }
  | { type: 'text'; text: string }
  | BrowserKeyInputDto
  | { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number };

export interface BrowserKeyInputDto {
  type: 'key';
  key: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface BrowserTargetDto {
  id: string;
  webSocketDebuggerUrl: string;
}
