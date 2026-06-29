import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Vite port config', () => {
  const originalWebPort = process.env.NUNCIO_WEB_PORT;
  const originalPort = process.env.PORT;

  afterEach(() => {
    vi.resetModules();
    if (originalWebPort === undefined) delete process.env.NUNCIO_WEB_PORT;
    else process.env.NUNCIO_WEB_PORT = originalWebPort;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  it('uses NUNCIO_WEB_PORT when running a worktree dev server', async () => {
    process.env.NUNCIO_WEB_PORT = '5174';
    process.env.NUNCIO_API_ORIGIN = 'http://localhost:3001';
    delete process.env.PORT;
    vi.resetModules();

    const config = (await import('./vite.config')).default as {
      server?: { port?: number; proxy?: Record<string, { target?: string }> };
      preview?: { port?: number; proxy?: Record<string, { target?: string }> };
    };

    expect(config.server?.port).toBe(5174);
    expect(config.preview?.port).toBe(5174);
    expect(config.server?.proxy?.['/api']?.target).toBe('http://localhost:3001');
    expect(config.preview?.proxy?.['/api']?.target).toBe('http://localhost:3001');
  });
});
