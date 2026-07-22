const HANDSHAKE_PREFIX = 'NUNCIO_CLIPROXY_CHILD ';
const HANDSHAKE_LIMIT_BYTES = 16 * 1024;
const START_TIMEOUT_MS = 5_000;
const STDERR_LIMIT_BYTES = 16 * 1024;
const CHILD_STOP_GRACE_MS = 1_000;

export interface ParentControlledChildHandle {
  pid: number;
  killed: boolean;
  hasExited: boolean;
  /** Closes the ownership pipe; EOF makes the launcher reap its child. */
  closeParentControl: () => void;
  kill: (signal?: NodeJS.Signals | number) => void;
  exited: Promise<number | null>;
}

export interface ParentControlledSpawnOptions {
  bin: string;
  configPath: string;
  cwd: string;
}

/**
 * Runs CLIProxyAPI behind a tiny Bun launcher whose stdin is owned by this daemon.
 * If the daemon is killed, the pipe closes and the launcher reaps CLIProxyAPI.
 */
export async function spawnWithParentControl(
  opts: ParentControlledSpawnOptions,
): Promise<ParentControlledChildHandle> {
  const launcher = Bun.spawn(
    [process.execPath, '--eval', launcherSource(), opts.bin, opts.configPath, opts.cwd],
    {
      cwd: opts.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const controlPipe = launcher.stdin;
  let controlClosed = false;
  const closeParentControl = () => {
    if (controlClosed) return;
    controlClosed = true;
    closeControlPipe(controlPipe);
  };
  let settled = false;
  const exited = launcher.exited.then(
    (code) => {
      settled = true;
      closeParentControl();
      return code;
    },
    (error) => {
      settled = true;
      closeParentControl();
      throw error;
    },
  );
  const stderr = readBoundedText(launcher.stderr, STDERR_LIMIT_BYTES).catch(() => '');
  const handshake = readHandshake(launcher.stdout);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`launcher handshake timed out after ${START_TIMEOUT_MS}ms`)),
      START_TIMEOUT_MS,
    );
  });

  let childPid: number;
  try {
    childPid = await Promise.race([
      handshake,
      exited.then((code) => {
        throw new Error(`launcher exited before handshake (code=${code})`);
      }),
      timeout,
    ]);
  } catch (error) {
    void handshake.catch(() => undefined);
    closeParentControl();
    try {
      launcher.kill('SIGKILL');
    } catch {
      // already gone
    }
    await exited.catch(() => undefined);
    const detail = (await stderr).trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to start managed CLIProxyAPI: ${message}${detail ? ` — ${detail}` : ''}`);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  return {
    pid: childPid,
    get killed() {
      return launcher.killed || settled;
    },
    get hasExited() {
      return settled;
    },
    closeParentControl,
    kill(signal?: NodeJS.Signals | number) {
      const requestedSignal = signal ?? 'SIGTERM';
      if (requestedSignal === 'SIGTERM' || requestedSignal === 'SIGINT') {
        closeParentControl();
        return;
      }
      try {
        launcher.kill(requestedSignal);
      } catch {
        // already gone
      }
    },
    exited,
  };
}

async function readHandshake(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes <= HANDSHAKE_LIMIT_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > HANDSHAKE_LIMIT_BYTES) {
        throw new Error('launcher handshake exceeded the size limit');
      }
      text += decoder.decode(value, { stream: true });
      const newline = text.indexOf('\n');
      if (newline < 0) continue;
      const line = text.slice(0, newline);
      if (!line.startsWith(HANDSHAKE_PREFIX)) {
        throw new Error('launcher returned an invalid handshake');
      }
      const payload = JSON.parse(line.slice(HANDSHAKE_PREFIX.length)) as { pid?: unknown };
      if (!Number.isInteger(payload.pid) || Number(payload.pid) <= 0) {
        throw new Error('launcher returned an invalid child pid');
      }
      return Number(payload.pid);
    }
    throw new Error('launcher stdout closed before handshake');
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  limitBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let remainingBytes = limitBytes;
  try {
    while (remainingBytes > 0) {
      const { value, done } = await reader.read();
      if (done) break;
      const retained = value.subarray(0, remainingBytes);
      remainingBytes -= retained.byteLength;
      text += decoder.decode(retained, { stream: true });
    }
    return text;
  } finally {
    reader.releaseLock();
  }
}

function closeControlPipe(stdin: number | { end(): unknown } | undefined): void {
  if (!stdin || typeof stdin === 'number') return;
  try {
    stdin.end();
  } catch {
    // already closed
  }
}

function launcherSource(): string {
  return String.raw`
const HANDSHAKE_PREFIX = ${JSON.stringify(HANDSHAKE_PREFIX)};
const CHILD_STOP_GRACE_MS = ${CHILD_STOP_GRACE_MS};
const [bin, configPath, cwd] = process.argv.slice(1);
let child = null;
let stopping = null;

async function stop(exitCode) {
  if (stopping) return stopping;
  stopping = (async () => {
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
      const result = await Promise.race([
        child.exited.then(() => 'exited', () => 'exited'),
        Bun.sleep(CHILD_STOP_GRACE_MS).then(() => 'timeout'),
      ]);
      if (result === 'timeout') {
        try { child.kill('SIGKILL'); } catch {}
        await child.exited.catch(() => undefined);
      }
    }
    process.exit(exitCode);
  })();
  return stopping;
}

void (async () => {
  try {
    for await (const _chunk of Bun.stdin.stream()) {}
    await stop(0);
  } catch {
    await stop(1);
  }
})();
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));

try {
  child = Bun.spawn([bin, '--config', configPath], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  process.stdout.write(HANDSHAKE_PREFIX + JSON.stringify({ pid: child.pid }) + '\n');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await stop(1);
}

const code = await child.exited;
if (!stopping) process.exit(code ?? 1);
`;
}
