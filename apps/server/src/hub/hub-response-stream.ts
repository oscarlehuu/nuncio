export interface HubResponseWriter {
  write(chunk: Uint8Array): boolean;
  destroy(): unknown;
  end(): unknown;
  on(event: 'drain' | 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
  off(event: 'drain' | 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
  writableEnded?: boolean;
  destroyed?: boolean;
}

export interface HubBodyReader {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

type ReadOutcome =
  | { type: 'read'; result: ReadableStreamReadResult<Uint8Array> }
  | { type: 'read-error' }
  | { type: 'terminated' };

/**
 * Copy an upstream byte stream into an HTTP response without reading ahead of
 * downstream backpressure. Only genuine upstream EOF ends cleanly; upstream
 * failures destroy the response, while downstream termination cancels the reader.
 */
export async function streamHubResponse(
  reader: HubBodyReader,
  res: HubResponseWriter,
): Promise<void> {
  let downstreamTerminated = false;
  let writeFailed = false;
  let readFailed = false;
  let upstreamDone = false;
  let drainResolver: (() => void) | undefined;
  let terminateReaderWait: (() => void) | undefined;
  let cancelPromise: Promise<void> | undefined;
  let activeReadOutcome: Promise<ReadOutcome> | undefined;
  let lockReleased = false;
  const readerTerminated = new Promise<void>((resolve) => {
    terminateReaderWait = resolve;
  });

  const cancelReader = (): Promise<void> => {
    if (!cancelPromise) {
      try {
        cancelPromise = Promise.resolve(reader.cancel()).catch(() => undefined);
      } catch {
        cancelPromise = Promise.resolve();
      }
    }
    return cancelPromise;
  };
  const releaseReaderLock = () => {
    if (lockReleased) return;
    try {
      reader.releaseLock();
      lockReleased = true;
    } catch {
      // A pending read retains the lock; its settlement schedules one retry.
    }
  };
  const releaseDrain = () => {
    const resolve = drainResolver;
    drainResolver = undefined;
    resolve?.();
  };
  const onDrain = () => releaseDrain();
  const onDownstreamTerminated = () => {
    if (downstreamTerminated) return;
    downstreamTerminated = true;
    releaseDrain();
    terminateReaderWait?.();
    void cancelReader();
  };

  res.on('drain', onDrain);
  res.on('close', onDownstreamTerminated);
  res.on('error', onDownstreamTerminated);

  try {
    while (!downstreamTerminated && !writeFailed) {
      const currentRead = Promise.resolve()
        .then(() => reader.read())
        .then((result): ReadOutcome => ({ type: 'read', result }))
        .catch((): ReadOutcome => ({ type: 'read-error' }));
      activeReadOutcome = currentRead;
      const readOutcome = await Promise.race<ReadOutcome>([
        currentRead,
        readerTerminated.then(() => ({ type: 'terminated' as const })),
      ]);
      if (readOutcome.type === 'terminated') break;
      activeReadOutcome = undefined;
      if (readOutcome.type === 'read-error') {
        readFailed = true;
        void cancelReader();
        break;
      }

      const result = readOutcome.result;
      if (downstreamTerminated) break;
      if (result.done) {
        upstreamDone = true;
        break;
      }
      if (!result.value) continue;

      let accepted: boolean;
      try {
        accepted = res.write(Buffer.from(result.value));
      } catch {
        writeFailed = true;
        void cancelReader();
        break;
      }
      if (!accepted && !downstreamTerminated) {
        await new Promise<void>((resolve) => {
          if (downstreamTerminated) return resolve();
          drainResolver = resolve;
        });
      }
    }
  } finally {
    releaseDrain();
    if (!upstreamDone || downstreamTerminated || writeFailed || readFailed) void cancelReader();

    if (
      (readFailed || writeFailed) &&
      !downstreamTerminated &&
      !res.writableEnded &&
      !res.destroyed
    ) {
      try {
        res.destroy();
      } catch {
        // The response is already unusable; never convert this failure to clean EOF.
      }
    }

    res.off('drain', onDrain);
    res.off('close', onDownstreamTerminated);
    res.off('error', onDownstreamTerminated);
    releaseReaderLock();
    if (!lockReleased && activeReadOutcome) {
      void activeReadOutcome.then(() => releaseReaderLock());
    }

    if (
      upstreamDone &&
      !downstreamTerminated &&
      !res.writableEnded &&
      !res.destroyed
    ) {
      try {
        res.end();
      } catch {
        // Genuine EOF was reached, but the downstream response is no longer writable.
      }
    }
  }
}
