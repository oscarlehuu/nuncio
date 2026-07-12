import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, jest } from 'bun:test';
import { EvidenceCaptureService } from '../../../src/evidence/evidence-capture.service';
import type { SessionDto } from '../../../src/sessions/domain/sessions.types';

function session(over: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 'session-1', worktreePath: '/repo/worktree', workspace: '/repo', projectPath: '/repo',
    ...over,
  } as SessionDto;
}

function harness() {
  const screenshot = jest.fn(async () => Buffer.from('png bytes'));
  let currentUrl = 'about:blank';
  const goto = jest.fn(async (url: string) => { currentUrl = url; });
  const pageUrl = jest.fn(() => currentUrl);
  const page = { goto, screenshot, url: pageUrl };
  const close = jest.fn(async () => undefined);
  const serverClose = jest.fn(async () => undefined);
  const kill = jest.fn(async () => undefined);
  const wsEndpoint = jest.fn(() => 'ws://evidence');
  const newPage = jest.fn(async () => page);
  const connect = jest.fn(async () => ({ newPage, close }));
  const launchServer = jest.fn(async () => ({ close: serverClose, kill, wsEndpoint }));
  const write = jest.fn(() => '0123456789abcdef0123456789abcdef');
  const readHead = jest.fn(async () => '0123456789abcdef');
  const browserState = jest.fn(async () => ({ connected: true, url: 'http://localhost:5173/app' }));
  const service = new EvidenceCaptureService(
    { launchServer, connect } as never,
    { write } as never,
    readHead,
    { state: browserState } as never,
  );
  return {
    service, launchServer, connect, newPage, goto, pageUrl, screenshot, close,
    serverClose, kill, write, readHead, browserState,
  };
}

describe('EvidenceCaptureService', () => {
  it('captures a before screenshot headlessly and stores only a PNG media ref', async () => {
    const h = harness();
    const result = await h.service.capture(session(), {
      url: 'http://localhost:5173/base', route: '/dashboard?tab=one', phase: 'before',
    });

    expect(h.launchServer).toHaveBeenCalledWith({ channel: 'chrome', headless: true });
    expect(h.connect).toHaveBeenCalledWith('ws://evidence');
    expect(h.newPage).toHaveBeenCalledWith({ viewport: { width: 1440, height: 900 } });
    expect(h.goto).toHaveBeenCalledWith('http://localhost:5173/dashboard?tab=one', {
      waitUntil: 'load', timeout: 15_000,
    });
    expect(h.screenshot).toHaveBeenCalledWith({ type: 'png', fullPage: true });
    expect(h.write).toHaveBeenCalledWith('session-1', Buffer.from('png bytes').toString('base64'));
    expect(h.readHead).toHaveBeenCalledTimes(2);
    expect(h.readHead).toHaveBeenCalledWith('/repo/worktree');
    expect(result).toEqual({
      beforeRef: { id: '0123456789abcdef0123456789abcdef', mimeType: 'image/png' },
      route: '/dashboard?tab=one', viewport: { w: 1440, h: 900 },
      workspaceHead: '0123456789abcdef',
    });
    expect(JSON.stringify(result)).not.toContain('png bytes');
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.serverClose).toHaveBeenCalledTimes(1);
  });

  it('remembers an explicit target for a later automatic after capture', async () => {
    const h = harness();
    await h.service.capture(session(), { url: 'http://localhost:5173', route: '/app', phase: 'before' });
    const result = await h.service.captureKnown(session(), 'after');
    expect(result).toMatchObject({ afterRef: { mimeType: 'image/png' }, route: '/app' });
    expect(h.launchServer).toHaveBeenCalledTimes(2);
  });

  it('no-ops automatic capture when no preview URL is known', async () => {
    const h = harness();
    await expect(h.service.captureKnown(session(), 'before')).resolves.toBeNull();
    expect(h.launchServer).not.toHaveBeenCalled();
  });

  it('forgets a known target when its session is deleted', async () => {
    const h = harness();
    await h.service.capture(session(), { url: 'http://localhost:5173', phase: 'before' });
    h.service.forget('session-1');
    await expect(h.service.captureKnown(session(), 'after')).resolves.toBeNull();
  });

  it('closes Chrome when navigation fails', async () => {
    const h = harness();
    h.goto.mockImplementation(async () => { throw new Error('navigation failed'); });
    await expect(h.service.capture(session(), { url: 'http://localhost:5173', phase: 'after' }))
      .rejects.toThrow('navigation failed');
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.serverClose).toHaveBeenCalledTimes(1);
  });

  it('rejects a caller-selected origin before launching Chrome', async () => {
    const h = harness();
    for (const url of [
      'http://127.0.0.1:3000/api/settings',
      'http://169.254.169.254/latest/meta-data',
      'https://localhost:5173/app',
      'http://localhost:3000/app',
    ]) {
      await expect(h.service.capture(session(), { url, phase: 'before' }))
        .rejects.toBeInstanceOf(BadRequestException);
    }
    expect(h.launchServer).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it('fails closed when the session has no registered preview origin', async () => {
    const h = harness();
    h.browserState.mockResolvedValue({ connected: false, url: null } as never);
    await expect(h.service.capture(session(), {
      url: 'http://localhost:5173/app', phase: 'before',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.launchServer).not.toHaveBeenCalled();
  });

  it('rejects a redirect that leaves the registered preview origin', async () => {
    const h = harness();
    h.pageUrl.mockReturnValue('http://169.254.169.254/latest/meta-data');
    await expect(h.service.capture(session(), {
      url: 'http://localhost:5173/app', phase: 'before',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.screenshot).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('accepts same-origin redirects and records their final route', async () => {
    const h = harness();
    h.pageUrl.mockReturnValue('http://localhost:5173/ready?mode=1#done');
    const result = await h.service.capture(session(), {
      url: 'http://localhost:5173/app', phase: 'before',
    });
    expect(result.route).toBe('/ready?mode=1#done');
  });

  it('serializes parallel captures so only one Chrome process is active', async () => {
    const h = harness();
    h.pageUrl.mockReturnValue('http://localhost:5173/app');
    let release!: () => void;
    h.goto.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = h.service.capture(session(), { url: 'http://localhost:5173/app', phase: 'before' });
    const second = h.service.capture(session(), { url: 'http://localhost:5173/app', phase: 'after' });
    while (h.goto.mock.calls.length === 0) await Promise.resolve();
    expect(h.launchServer).toHaveBeenCalledTimes(1);
    release();
    await first;
    await second;
    expect(h.launchServer).toHaveBeenCalledTimes(2);
  });

  it('kills in-flight Chrome on module shutdown during navigation', async () => {
    const h = harness();
    let rejectNavigation!: (error: Error) => void;
    h.goto.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectNavigation = reject; }));
    h.kill.mockImplementation((async () => rejectNavigation(new Error('browser killed'))) as never);
    const capture = h.service.capture(session(), { url: 'http://localhost:5173/app', phase: 'before' });
    while (h.goto.mock.calls.length === 0) await Promise.resolve();
    await h.service.onModuleDestroy();
    await expect(capture).rejects.toThrow('browser killed');
    expect(h.kill).toHaveBeenCalled();
  });

  it('kills Chrome if shutdown begins while launch is still pending', async () => {
    const h = harness();
    let finishLaunch!: (server: unknown) => void;
    h.launchServer.mockImplementationOnce(() => new Promise((resolve) => { finishLaunch = resolve; }));
    const capture = h.service.capture(session(), { url: 'http://localhost:5173/app', phase: 'before' });
    while (h.launchServer.mock.calls.length === 0) await Promise.resolve();
    await h.service.onModuleDestroy();
    finishLaunch({ close: h.serverClose, kill: h.kill, wsEndpoint: () => 'ws://evidence' });
    await expect(capture).rejects.toThrow('shutting down');
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.kill).toHaveBeenCalled();
  });

  it('does not restore a known target forgotten during capture', async () => {
    const h = harness();
    h.pageUrl.mockReturnValue('http://localhost:5173/app');
    let release!: () => void;
    h.goto.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const capture = h.service.capture(session(), { url: 'http://localhost:5173/app', phase: 'before' });
    while (h.goto.mock.calls.length === 0) await Promise.resolve();
    h.service.forget('session-1');
    release();
    await expect(capture).rejects.toThrow('cleared');
    await expect(h.service.captureKnown(session(), 'after')).resolves.toBeNull();
    expect(h.write).not.toHaveBeenCalled();
  });

  it('falls back to killing Chrome when graceful browser close rejects', async () => {
    const h = harness();
    h.close.mockRejectedValue(new Error('close failed'));
    await h.service.capture(session(), { url: 'http://localhost:5173/app', phase: 'before' });
    expect(h.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects evidence when HEAD changes during capture', async () => {
    const h = harness();
    h.readHead.mockResolvedValueOnce('a'.repeat(40)).mockResolvedValueOnce('b'.repeat(40));
    await expect(h.service.capture(session(), { url: 'http://localhost:5173', phase: 'after' }))
      .rejects.toThrow('Workspace HEAD changed');
    expect(h.write).not.toHaveBeenCalled();
  });

  it('preserves hash-router paths in the evidence route', async () => {
    const h = harness();
    const result = await h.service.capture(session(), {
      url: 'http://localhost:5173', route: '/#/settings', phase: 'before',
    });
    expect(result.route).toBe('/#/settings');
  });

  it('rejects unsafe targets, missing workspaces, and missing git HEAD', async () => {
    const h = harness();
    await expect(h.service.capture(session(), { url: 'file:///etc/passwd', phase: 'before' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.capture(session(), {
      url: 'http://localhost:5173', route: 'http://other-host.test/private', phase: 'before',
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.capture(session({ worktreePath: null, workspace: null, projectPath: null }), {
      url: 'http://localhost:5173', phase: 'before',
    })).rejects.toBeInstanceOf(BadRequestException);
    h.readHead.mockImplementation(async () => null as never);
    await expect(h.service.capture(session(), { url: 'http://localhost:5173', phase: 'after' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
