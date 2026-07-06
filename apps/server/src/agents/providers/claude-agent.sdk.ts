/**
 * The Claude Agent SDK boundary. The provider depends only on the narrow types
 * and factory here, so specs inject a fake `query` (constructor-injected factory,
 * no module mock) and the SDK is loaded lazily at first real use rather than at
 * module import time.
 */

/**
 * A base64 image content block, exactly the Anthropic `ImageBlockParam` shape the
 * model reads. Built from a MediaStore attachment ({ mimeType, data }).
 */
export interface ClaudeImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

/** A plain text content block. */
export interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

/** What we send as message content: a bare string, or a blocks array (text + images). */
export type ClaudeUserContent = string | Array<ClaudeTextBlock | ClaudeImageBlock>;

/** A user message in the SDK's streaming-input shape (narrowed to what we send). */
export interface ClaudeUserMessage {
  type: 'user';
  parent_tool_use_id: null;
  message: { role: 'user'; content: ClaudeUserContent };
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

/**
 * A single `tool_result` content block the SDK delivers on a `user` message when
 * a tool finishes. `content` is the Anthropic union: a bare string, or an array
 * of blocks; the mapping flattens either to a text output.
 */
export interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
}

/**
 * A `user`-typed SDK message. Tool results arrive here: `message.content` is an
 * array carrying `tool_result` blocks (each pairing back to a `tool_use.id`).
 * Non-tool-result user frames (replays, steer echoes) carry no such block.
 */
export interface ClaudeUserResultMessage {
  type: 'user';
  message?: { content?: unknown };
}

/** Message types the provider does not act on beyond deltas + terminal result. */
export interface ClaudeOtherMessage {
  type: 'assistant' | 'stream' | 'other';
}

/**
 * SDK messages the provider inspects — a structural subset of the full SDK
 * union. The factory casts the real (wider) SDK message to this narrowed union;
 * message types outside the ones the provider maps arrive typed as
 * ClaudeOtherMessage and fall through the handler untouched.
 */
export type ClaudeSdkMessage =
  | ClaudeSystemMessage
  | ClaudeStreamEventMessage
  | ClaudeResultMessage
  | ClaudeUserResultMessage
  | ClaudeOtherMessage;

export interface ClaudeQuery extends AsyncIterable<ClaudeSdkMessage> {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  /**
   * Mid-session flag change (streaming-input mode). Effort is the only flag we
   * push through today; optional because a fake/older query may not implement it.
   */
  applyFlagSettings?(settings: { effortLevel?: string }): Promise<void>;
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
      async applyFlagSettings(settings: { effortLevel?: string }): Promise<void> {
        const query = (await load()) as ClaudeQuery & {
          applyFlagSettings?: (s: { effortLevel?: string }) => Promise<void>;
        };
        await query.applyFlagSettings?.(settings);
      },
    };
  };
}
