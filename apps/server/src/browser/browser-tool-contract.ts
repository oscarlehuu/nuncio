import type { BrowserToolName } from './browser.types';

export interface BrowserToolDefinition {
  name: BrowserToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

const targetProperty = {
  type: 'string',
  enum: ['auto', 'in_app', 'external'],
  description:
    'Omit to use the configured default browser. auto prefers the Nuncio in-app browser, then falls back to the Nuncio-owned external CDP browser.',
};

const sessionIdProperty = {
  type: 'string',
  description: 'Nuncio session id that owns the browser state and artifacts.',
};

export const BROWSER_TOOL_DEFINITIONS: BrowserToolDefinition[] = [
  {
    name: 'browser_open',
    description: 'Open a URL in the Nuncio-managed browser for this session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: sessionIdProperty,
        url: { type: 'string', description: 'URL or host to open. Defaults to about:blank.' },
        target: targetProperty,
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_get_state',
    description: 'Read the current URL, title, loading state, and selected browser target.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: sessionIdProperty, target: targetProperty },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot from the selected Nuncio browser.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: sessionIdProperty, target: targetProperty },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click a viewport coordinate in the selected Nuncio browser.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: sessionIdProperty,
        x: { type: 'number' },
        y: { type: 'number' },
        target: targetProperty,
      },
      required: ['sessionId', 'x', 'y'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into the focused element in the selected Nuncio browser.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: sessionIdProperty,
        text: { type: 'string' },
        target: targetProperty,
      },
      required: ['sessionId', 'text'],
    },
  },
  {
    name: 'browser_key',
    description: 'Press a keyboard key in the selected Nuncio browser.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: sessionIdProperty,
        key: { type: 'string' },
        code: { type: 'string' },
        altKey: { type: 'boolean' },
        ctrlKey: { type: 'boolean' },
        metaKey: { type: 'boolean' },
        shiftKey: { type: 'boolean' },
        target: targetProperty,
      },
      required: ['sessionId', 'key'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the selected Nuncio browser at a viewport coordinate.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: sessionIdProperty,
        x: { type: 'number' },
        y: { type: 'number' },
        deltaX: { type: 'number' },
        deltaY: { type: 'number' },
        target: targetProperty,
      },
      required: ['sessionId', 'x', 'y', 'deltaX', 'deltaY'],
    },
  },
];
