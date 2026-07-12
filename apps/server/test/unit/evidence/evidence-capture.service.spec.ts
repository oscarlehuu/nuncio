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
  const goto = jest.fn(async () => undefined);
  const page = { goto, screenshot };
  const close = jest.fn(async () => undefined);
  const newPage = jest.fn(async () => page);
  const launch = jest.fn(async () => ({ newPage, close }));
  const write = jest.fn(() => '0123456789abcdef0123456789abcdef');
  const readHead = jest.fn(async () => '0123456789abcdef');
  const service = new EvidenceCaptureService(
    { launch } as never,
    { write } as never,
    readHead,
  );
  return { service, launch, newPage, goto, screenshot, close, write, readHead };
}

describe('EvidenceCaptureService', () => {
  it('captures a before screenshot headlessly and stores only a PNG media ref', async () => {
    const h = harness();
    const result = await h.service.capture(session(), {
      url: 'http://localhost:5173/base', route: '/dashboard?tab=one', phase: 'before',
    });

    expect(h.launch).toHaveBeenCalledWith({ channel: 'chrome', headless: true });
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
  });

  it('remembers an explicit target for a later automatic after capture', async () => {
    const h = harness();
    await h.service.capture(session(), { url: 'http://localhost:5173', route: '/app', phase: 'before' });
    const result = await h.service.captureKnown(session(), 'after');
    expect(result).toMatchObject({ afterRef: { mimeType: 'image/png' }, route: '/app' });
    expect(h.launch).toHaveBeenCalledTimes(2);
  });

  it('no-ops automatic capture when no preview URL is known', async () => {
    const h = harness();
    await expect(h.service.captureKnown(session(), 'before')).resolves.toBeNull();
    expect(h.launch).not.toHaveBeenCalled();
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
