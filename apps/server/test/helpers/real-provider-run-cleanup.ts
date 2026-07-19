/** Stop a real-provider run before an integration fixture tears down its resources. */
export async function settleRealProviderRun(
  run: Promise<void>,
  interrupt: () => Promise<void>,
  timeoutMs = 10_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settlement = (async () => {
    await interrupt().catch(() => undefined);
    await run.then(() => undefined, () => undefined);
  })();
  try {
    await Promise.race([
      settlement,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Real provider run did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
