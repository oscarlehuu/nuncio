import { describe, expect, it, jest } from 'bun:test';
import {
  SimulatorEvidenceCaptureService,
  pngViewport,
} from '../../../src/evidence/simulator-evidence-capture.service';

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe('SimulatorEvidenceCaptureService', () => {
  it('returns a clear capability reason and never captures when xcrun is absent', async () => {
    const service = new SimulatorEvidenceCaptureService();
    service.platform = 'darwin';
    service.exec = jest.fn(async () => ({ ok: false }));
    await expect(service.capability()).resolves.toEqual({
      available: false, reason: 'xcrun with simctl is unavailable',
    });
    await expect(service.captureScreenshot()).resolves.toEqual({
      ok: false, reason: 'xcrun with simctl is unavailable',
    });
    expect(service.exec).toHaveBeenCalledTimes(2);
    expect(service.exec).not.toHaveBeenCalledWith(expect.arrayContaining(['screenshot']));
  });

  it('does not probe xcrun off macOS', async () => {
    const service = new SimulatorEvidenceCaptureService();
    service.platform = 'linux';
    service.exec = jest.fn(async () => ({ ok: true }));
    await expect(service.capability()).resolves.toEqual({
      available: false, reason: 'iOS Simulator capture requires macOS',
    });
    expect(service.exec).not.toHaveBeenCalled();
  });

  it('runs the booted screenshot command, returns PNG dimensions, and cleans up', async () => {
    const service = new SimulatorEvidenceCaptureService();
    service.platform = 'darwin';
    service.tmpdirFn = () => '/safe-temp';
    service.exec = jest.fn(async () => ({ ok: true }));
    const rm = jest.fn(async () => undefined);
    service.files = {
      mkdtemp: jest.fn(async () => '/safe-temp/capture'),
      readFile: jest.fn(async () => png(1179, 2556)),
      rm,
    } as never;

    const result = await service.captureScreenshot();

    expect(service.exec).toHaveBeenCalledWith([
      'xcrun', 'simctl', 'io', 'booted', 'screenshot', '/safe-temp/capture/screenshot.png',
    ]);
    expect(result).toMatchObject({ ok: true, viewport: { w: 1179, h: 2556 }, route: 'simulator://booted' });
    expect(rm).toHaveBeenCalledWith('/safe-temp/capture', { recursive: true, force: true });
  });

  it('rejects non-PNG capture bytes', () => {
    expect(pngViewport(Buffer.from('not png'))).toBeNull();
    const malformed = png(100, 200);
    malformed.write('NOPE', 12, 'ascii');
    expect(pngViewport(malformed)).toBeNull();
  });
});
