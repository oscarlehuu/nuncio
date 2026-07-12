import { describe, expect, it } from 'bun:test';
import { isEvidenceCapturedEvent } from '../../../src/sessions/domain/events.types';

describe('evidence_captured event', () => {
  it('accepts a ref-only before payload', () => {
    expect(isEvidenceCapturedEvent({
      type: 'evidence_captured',
      payload: {
        beforeRef: { id: '0123456789abcdef0123456789abcdef', mimeType: 'image/png' },
        route: '/dashboard',
        viewport: { w: 1440, h: 900 },
        workspaceHead: 'abc123',
      },
    })).toBe(true);
  });

  it('rejects inline screenshot bytes and malformed viewports', () => {
    expect(isEvidenceCapturedEvent({
      type: 'evidence_captured',
      payload: {
        afterRef: { id: 'id', mimeType: 'image/png', data: 'base64' },
        route: '/',
        viewport: { w: 0, h: 900 },
        workspaceHead: 'abc123',
      },
    })).toBe(false);
  });
});
