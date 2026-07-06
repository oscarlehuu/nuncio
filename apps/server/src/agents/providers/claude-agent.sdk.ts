/**
 * The Claude Agent SDK boundary. The provider depends only on the narrow types
 * and factory here, so specs inject a fake `query` (constructor-injected factory,
 * no module mock) and the SDK is loaded lazily at first real use rather than at
 * module import time.
 */

/** A user message in the SDK's streaming-input shape (narrowed to what we send). */
export interface ClaudeUserMessage {
  type: 'user';
  parent_tool_use_id: null;
  message: { role: 'user'; content: unknown };
  priority?: 'now' | 'next' | 'later';
}

export interface ClaudeSystemMessage {
  type: 'system';
  subtype: string;
  session_id?: string;
}

export interface ClaudeStreamEventMessage {
  type: 'stream_event';
  uuid: string;
  event: {
    type: string;
    index?: number;
    delta?: { type?: string; text?: string; thinking?: string };
    content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  };
}

export interface ClaudeResultMessage {
  type: 'result';
  subtype: string;
  result?: string;
  errors?: string[];
  terminal_reason?: string;
}

/** Message types the provider does not act on beyond deltas + terminal result. */
export interface ClaudeOtherMessage {
  type: 'assistant' | 'user' | 'stream' | 'other';
}

/**
 * SDK messages the provider inspects — a structural subset of the full SDK
 * union. The factory casts the real (wider) SDK message to this narrowed union;
 * message types outside the three the provider maps arrive typed as
 * ClaudeOtherMessage and fall through the handler untouched.
 */
export type ClaudeSdkMessage =
  | ClaudeSystemMessage
  | ClaudeStreamEventMessage
  | ClaudeResultMessage
  | ClaudeOtherMessage;

export interface ClaudeQuery extends AsyncIterable<ClaudeSdkMessage> {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
}

/** Permission modes the founder setting exposes; mirrors the SDK's PermissionMode subset we use. */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/** An in-process SDK MCP server config, passed straight through to the SDK. */
export interface ClaudeMcpServer {
  type: 'sdk';
  name: string;
  instance: unknown;
}

export interface ClaudeQueryOptions {
  cwd: string;
  includePartialMessages: true;
  settingSources: [];
  permissionMode: ClaudePermissionMode;
  canUseTool: ClaudeCanUseTool;
  abortController: AbortController;
  model?: string;
  resume?: string;
  effort?: string;
  env?: Record<string, string | undefined>;
  pathToClaudeCodeExecutable?: string;
  mcpServers?: Record<string, ClaudeMcpServer>;
  appendSystemPrompt?: string;
}

/** The callback options payload the SDK hands to `canUseTool` (structural subset we read). */
export interface ClaudeCanUseToolOptions {
  signal?: AbortSignal;
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID?: string;
  requestId: string;
}

export type ClaudeCanUseToolResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string };

export type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: ClaudeCanUseToolOptions,
) => Promise<ClaudeCanUseToolResult>;

export type ClaudeQueryFactory = (params: {
  prompt: AsyncIterable<ClaudeUserMessage>;
  options: ClaudeQueryOptions;
}) => ClaudeQuery;

import type { CreateSdkMcpServer } from '../tools/claude-runtime-tools.adapter';

/**
 * Lazy accessor for the SDK's `createSdkMcpServer`. The provider builds the
 * in-process runtime-tools server at query construction; importing it lazily
 * keeps the SDK (and its bundled CLI) out of module-import time. The first call
 * imports synchronously-cached; callers that need the server before the first
 * turn await `loadCreateSdkMcpServer()` once.
 */
export async function loadCreateSdkMcpServer(): Promise<CreateSdkMcpServer> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.createSdkMcpServer as unknown as CreateSdkMcpServer;
}

/**
 * Real factory: lazy-imports the SDK's `query` so importing the provider never
 * forces the SDK (and its bundled CLI) to load. The returned handle proxies the
 * async iterator and the two control methods the provider calls.
 */
export function buildClaudeQueryFactory(): ClaudeQueryFactory {
  return (params) => {
    let realQuery: Promise<ClaudeQuery> | undefined;
    const load = (): Promise<ClaudeQuery> => {
      realQuery ??= import('@anthropic-ai/claude-agent-sdk').then((sdk) =>
        (sdk.query as unknown as ClaudeQueryFactory)(params),
      );
      return realQuery;
    };

    return {
      async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
        const query = await load();
        for await (const message of query) yield message as ClaudeSdkMessage;
      },
      async interrupt(): Promise<void> {
        return (await load()).interrupt();
      },
      async setModel(model?: string): Promise<void> {
        return (await load()).setModel(model);
      },
    };
  };
}
