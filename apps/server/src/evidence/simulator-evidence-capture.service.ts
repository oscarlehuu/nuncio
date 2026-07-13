import { Injectable } from '@nestjs/common';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimulatorCapability, SimulatorCapture, SimulatorExec } from './evidence.types';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function defaultSimulatorExec(argv: string[]): Promise<{ ok: boolean; stderr?: string }> {
  try {
    const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    const stderr = await new Response(proc.stderr).text();
    return { ok: await proc.exited === 0, stderr };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : 'spawn failed' };
  }
}

export function pngViewport(bytes: Buffer): { w: number; h: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** Narrow simulator driver; recordVideo can be added here without changing evidence storage. */
@Injectable()
export class SimulatorEvidenceCaptureService {
  exec: SimulatorExec = defaultSimulatorExec;
  platform: NodeJS.Platform = process.platform;
  tmpdirFn: () => string = tmpdir;
  files = { mkdtemp, readFile, rm };

  async capability(): Promise<SimulatorCapability> {
    if (this.platform !== 'darwin') {
      return { available: false, reason: 'iOS Simulator capture requires macOS' };
    }
    const result = await this.exec(['xcrun', '--find', 'simctl']);
    return result.ok
      ? { available: true }
      : { available: false, reason: 'xcrun with simctl is unavailable' };
  }

  async captureScreenshot(): Promise<SimulatorCapture> {
    const capability = await this.capability();
    if (!capability.available) return { ok: false, reason: capability.reason };

    const directory = await this.files.mkdtemp(join(this.tmpdirFn(), 'nuncio-simulator-'));
    const output = join(directory, 'screenshot.png');
    try {
      const result = await this.exec(['xcrun', 'simctl', 'io', 'booted', 'screenshot', output]);
      if (!result.ok) {
        return { ok: false, reason: result.stderr?.trim() || 'Simulator screenshot failed' };
      }
      const bytes = await this.files.readFile(output);
      const viewport = pngViewport(bytes);
      if (!viewport) return { ok: false, reason: 'Simulator returned an invalid PNG screenshot' };
      return { ok: true, bytes, viewport, route: 'simulator://booted' };
    } finally {
      await this.files.rm(directory, { recursive: true, force: true });
    }
  }
}
