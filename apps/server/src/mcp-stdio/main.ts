import { createMcpRuntime } from './runtime';
import { runStdioServer } from './stdio-server';

const runtime = createMcpRuntime({
  apiOrigin: process.env.NUNCIO_API_ORIGIN || 'http://127.0.0.1:3000',
  authToken: process.env.NUNCIO_AUTH_TOKEN || process.env.NUNCIO_API_TOKEN,
});

void runStdioServer(runtime, {
  stdin: process.stdin,
  stdout: process.stdout,
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
