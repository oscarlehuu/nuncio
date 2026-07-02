import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalService } from '../../../src/terminal/terminal.service';
import { isLoopbackAddress } from '../../../src/terminal/loopback';

describe('TerminalService', () => {
  let service: TerminalService | undefined;
  let cwd: string | undefined;

  afterEach(() => {
    service?.killAll();
    service = undefined;
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  it('creates a Bun native PTY, streams output, resizes, and kills it', async () => {
    service = new TerminalService();
    cwd = mkdtempSync(join(tmpdir(), 'nuncio-pty-'));
    const chunks: string[] = [];

    service.setOutputSink('pty-1', (chunk) => chunks.push(chunk));
    service.create({ id: 'pty-1', cwd, cols: 120, rows: 40 });
    service.write('pty-1', 'echo NUNCIO_PTY_OK\n');
    service.resize('pty-1', 100, 30);

    await waitFor(() => chunks.join('').includes('NUNCIO_PTY_OK'));

    expect(chunks.join('')).toContain('NUNCIO_PTY_OK');
    expect(() => service?.kill('pty-1')).not.toThrow();
  });

  it('recognizes only loopback remote addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for PTY output');
}
