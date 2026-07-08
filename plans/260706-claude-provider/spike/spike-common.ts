// Shared helpers for spike scripts. No mocks — every value comes from a live run.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export const HAIKU = "claude-haiku-4-5-20251001";
export const WS1 = "/tmp/nuncio-claude-spike/ws1";
export const WS2 = "/tmp/nuncio-claude-spike/ws2"; // has CLAUDE.md marker (S10)
export const WS3 = "/tmp/nuncio-claude-spike/ws3"; // resume target (S4)

// Scrub PII from captured evidence without hardcoding the real values into a
// committed file: match any UUID (orgId shape) and any email.
export function redact(s: string): string {
  return s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<org-uuid>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
}

// Build a user message in streaming-input shape.
export function userMsg(
  text: string,
  extra: Partial<SDKUserMessage> = {},
): SDKUserMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: text },
    ...extra,
  } as SDKUserMessage;
}

// A manually-controlled async queue so we can push mid-run messages (S2/S8).
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolvers: ((v: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(m: SDKUserMessage) {
    const r = this.resolvers.shift();
    if (r) r({ value: m, done: false });
    else this.queue.push(m);
  }
  close() {
    this.closed = true;
    let r;
    while ((r = this.resolvers.shift())) r({ value: undefined as any, done: true });
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>((res) =>
        this.resolvers.push(res),
      );
      if (next.done) return;
      yield next.value;
    }
  }
}

// Trim long strings for logging.
export function trim(v: unknown, max = 300): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + `…[+${s.length - max}]` : s;
}
