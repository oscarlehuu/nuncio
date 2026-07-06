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

export interface ClaudeQueryOptions {
  cwd: string;
  includePartialMessages: true;
  settingSources: [];
  permissionMode: 'acceptEdits';
  canUseTool: ClaudeCanUseTool;
  abortController: AbortController;
  model?: string;
  resume?: string;
  effort?: string;
  env?: Record<string, string | undefined>;
  pathToClaudeCodeExecutable?: string;
}

export type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: unknown,
) => Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }>;

export type ClaudeQueryFactory = (params: {
  prompt: AsyncIterable<ClaudeUserMessage>;
  options: ClaudeQueryOptions;
}) => ClaudeQuery;

/**
 * Permissive tool gate — a clearly-isolated Phase-2 seam. Tools are gated via
 * this callback (never via bare `allowedTools`, which would shadow it), so the
 * approval flow swaps in here without touching the query construction. Until
 * then everything is allowed with the model's own input unchanged.
 */
export const permissiveCanUseTool: ClaudeCanUseTool = async (_toolName, input) => ({
  behavior: 'allow',
  updatedInput: input,
});

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
