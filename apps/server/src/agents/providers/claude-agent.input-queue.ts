import type { ClaudeUserMessage } from './claude-agent.sdk';

/**
 * A manually-driven async queue that feeds the SDK's streaming-input iterable.
 * `executePrompt` and `steerMidRun` push messages into the same open iterable
 * so the SDK query is never recreated mid-session. Closing releases any pending
 * consumer so the SDK generator can finish.
 */
export class InputQueue implements AsyncIterable<ClaudeUserMessage> {
  private readonly queue: ClaudeUserMessage[] = [];
  private resolvers: ((result: IteratorResult<ClaudeUserMessage>) => void)[] = [];
  private closed = false;

  push(message: ClaudeUserMessage): void {
    const resolver = this.resolvers.shift();
    if (resolver) resolver({ value: message, done: false });
    else this.queue.push(message);
  }

  close(): void {
    this.closed = true;
    let resolver: ((result: IteratorResult<ClaudeUserMessage>) => void) | undefined;
    while ((resolver = this.resolvers.shift())) {
      resolver({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ClaudeUserMessage> {
    while (true) {
      const buffered = this.queue.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<ClaudeUserMessage>>((resolve) =>
        this.resolvers.push(resolve),
      );
      if (next.done) return;
      yield next.value;
    }
  }
}
