const GIT_TIMEOUT_MS = 3000;

/** Exact HEAD witness for evidence; returns null outside a readable git checkout. */
export async function readEvidenceGitHead(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, GIT_TIMEOUT_MS);
    try {
      const output = await new Response(proc.stdout).text().catch(() => '');
      const exitCode = await proc.exited;
      const head = output.trim();
      return !timedOut && exitCode === 0 && /^[a-f0-9]{40,64}$/i.test(head) ? head : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
