import { BadRequestException } from '@nestjs/common';
import { BrowserController } from '../../../src/browser/browser.controller';

describe('BrowserController', () => {
  it('opens a session browser with an optional URL', async () => {
    const open = jest.fn(async () => ({
      connected: true,
      url: 'https://example.com/',
      title: 'Example',
      loading: false,
      screenshotVersion: 1,
    }));
    const controller = new BrowserController({ open } as never);

    await expect(controller.open('s1', { url: 'example.com' })).resolves.toMatchObject({
      url: 'https://example.com/',
    });
    expect(open).toHaveBeenCalledWith('s1', 'example.com');
  });

  it('rejects unknown browser input types', async () => {
    const controller = new BrowserController({ input: jest.fn() } as never);

    expect(() => controller.input('s1', { type: 'drag' } as never)).toThrow(BadRequestException);
  });

  it('writes screenshot bytes as image/png', async () => {
    const screenshot = jest.fn(async () => Buffer.from('png'));
    const controller = new BrowserController({ screenshot } as never);
    const res = {
      setHeader: jest.fn(),
      send: jest.fn(),
    };

    await controller.screenshot('s1', res as never);

    expect(screenshot).toHaveBeenCalledWith('s1');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('png'));
  });
});
