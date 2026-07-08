import { handleJsonRpcMessage } from './json-rpc';
import type { McpRuntime } from './runtime';
import type { JsonRpcRequest } from './types';

export interface StdioLike {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

export async function runStdioServer(runtime: McpRuntime, io: StdioLike): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of io.stdin as AsyncIterable<Buffer | string>) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '').trim();
      if (!line) continue;
      const response = await handleJsonRpcMessage(runtime, JSON.parse(line) as JsonRpcRequest);
      if (response) await writeLine(io.stdout, JSON.stringify(response));
    }
  }
}

async function writeLine(stdout: NodeJS.WritableStream, line: string): Promise<void> {
  await new Promise<void>((resolve) => {
    if (stdout.write(`${line}\n`)) resolve();
    else stdout.once('drain', resolve);
  });
}
