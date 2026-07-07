export interface BrowserStateDto {
  connected: boolean;
  url: string | null;
  title: string | null;
  loading: boolean;
  screenshotVersion: number;
}

export type BrowserResolvedTarget = 'in_app' | 'external';
export type BrowserTargetPreference = 'auto' | BrowserResolvedTarget;

export interface BrowserToolOptions {
  target?: BrowserTargetPreference;
}

export interface BrowserToolStateDto extends BrowserStateDto {
  target: BrowserResolvedTarget;
}

export interface BrowserBackend {
  readonly id: BrowserResolvedTarget;
  isAvailable(): boolean;
  open(sessionId: string, url?: string): Promise<BrowserStateDto>;
  state(sessionId: string): Promise<BrowserStateDto>;
  screenshot(sessionId: string): Promise<Buffer>;
  input(sessionId: string, input: BrowserInputDto): Promise<BrowserStateDto>;
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

export type BrowserToolName =
  | 'browser_open'
  | 'browser_get_state'
  | 'browser_screenshot'
  | 'browser_click'
  | 'browser_type'
  | 'browser_key'
  | 'browser_scroll';

export type BrowserToolCallInput = Record<string, unknown>;

export type BrowserToolResult =
  | { type: 'state'; state: BrowserToolStateDto }
  | {
      type: 'screenshot';
      target: BrowserResolvedTarget;
      mimeType: 'image/png';
      data: string;
    };
