import { describe, expect, it } from 'bun:test';
import {
  buildCaptureEvidenceTool,
  CAPTURE_EVIDENCE_TOOL_NAME,
  normalizeCaptureEvidenceInput,
  type CaptureEvidenceToolDeps,
} from '../../../src/agents/pi-engine/capture-evidence-tool';

type ToolShape = {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

function toolWith(deps: CaptureEvidenceToolDeps): ToolShape {
  return buildCaptureEvidenceTool(deps) as ToolShape;
}

describe('normalizeCaptureEvidenceInput', () => {
  it('defaults the phase to after', () => {
    expect(normalizeCaptureEvidenceInput({ url: 'http://localhost:5173' })).toEqual({
      value: { url: 'http://localhost:5173', phase: 'after' },
    });
  });

  it('accepts an explicit before phase and a route label', () => {
    expect(
      normalizeCaptureEvidenceInput({
        url: 'https://app.local/settings',
        route: '/settings',
        phase: 'before',
      }),
    ).toEqual({
      value: { url: 'https://app.local/settings', route: '/settings', phase: 'before' },
    });
  });

  it('allows omitting the url (deps fall back to the known target)', () => {
    expect(normalizeCaptureEvidenceInput({})).toEqual({ value: { phase: 'after' } });
    expect(normalizeCaptureEvidenceInput(undefined)).toEqual({ value: { phase: 'after' } });
  });

  it('rejects a non-http url and a bad phase', () => {
    expect(normalizeCaptureEvidenceInput({ url: 'file:///etc/passwd' })).toMatchObject({
      error: expect.stringContaining('http'),
    });
    expect(normalizeCaptureEvidenceInput({ phase: 'during' })).toMatchObject({
      error: expect.stringContaining('phase'),
    });
  });
});

describe('buildCaptureEvidenceTool', () => {
  it('is named capture_evidence', () => {
    const tool = toolWith({ capture: async () => ({ ok: true, route: '/', workspaceHead: 'h' }) });
    expect(tool.name).toBe(CAPTURE_EVIDENCE_TOOL_NAME);
  });

  it('captures and echoes the route + head so the agent can cite it', async () => {
    const calls: unknown[] = [];
    const tool = toolWith({
      capture: async (input) => {
        calls.push(input);
        return { ok: true, route: '/settings', workspaceHead: 'abc1234' };
      },
    });

    const result = await tool.execute('call-1', {
      url: 'http://localhost:5173/settings',
      phase: 'after',
    });

    expect(calls).toEqual([
      { url: 'http://localhost:5173/settings', phase: 'after' },
    ]);
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('/settings');
    expect(result.content[0]!.text).toContain('abc1234');
  });

  it('reports a capture failure as a tool error without throwing', async () => {
    const tool = toolWith({
      capture: async () => ({ ok: false, reason: 'dev server is not running' }),
    });
    const result = await tool.execute('call-2', { url: 'http://localhost:5173' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('dev server is not running');
  });

  it('rejects invalid input at the boundary', async () => {
    const tool = toolWith({
      capture: async () => {
        throw new Error('must not be called');
      },
    });
    const result = await tool.execute('call-3', { url: 'ftp://nope' });
    expect(result.isError).toBe(true);
  });
});
