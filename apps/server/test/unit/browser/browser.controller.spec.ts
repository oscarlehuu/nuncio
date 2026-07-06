import 'reflect-metadata';
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
    expect(open).toHaveBeenCalledWith('s1', 'example.com', { target: undefined });
  });

  it('passes explicit browser targets to open and input', async () => {
    const open = jest.fn(async () => ({
      connected: true,
      url: 'https://example.com/',
      title: 'Example',
      loading: false,
      screenshotVersion: 1,
      target: 'in_app',
    }));
    const input = jest.fn(async () => ({
      connected: true,
      url: 'https://example.com/',
      title: 'Example',
      loading: false,
      screenshotVersion: 2,
      target: 'in_app',
    }));
    const controller = new BrowserController({ open, input } as never);

    await controller.open('s1', { url: 'example.com', target: 'in_app' });
    await controller.input('s1', { type: 'click', x: 10, y: 20, target: 'in_app' });

    expect(open).toHaveBeenCalledWith('s1', 'example.com', { target: 'in_app' });
    expect(input).toHaveBeenCalledWith('s1', { type: 'click', x: 10, y: 20 }, { target: 'in_app' });
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

    await controller.screenshot('s1', {}, res as never);

    expect(screenshot).toHaveBeenCalledWith('s1', { target: undefined });
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('png'));
  });
});
