import { describe, expect, it } from 'vitest';
import { normalizeEvidenceCapturedPayload } from './evidence.types';

describe('normalizeEvidenceCapturedPayload', () => {
  it('keeps one media ref and the git/viewport witness', () => {
    expect(normalizeEvidenceCapturedPayload({
      beforeRef: { id: 'media-id', mimeType: 'image/png' },
      route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'abc123',
    })).toEqual({
      beforeRef: { id: 'media-id', mimeType: 'image/png' },
      route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'abc123',
    });
  });

  it('rejects payloads with both phases or invalid viewport dimensions', () => {
    expect(normalizeEvidenceCapturedPayload({
      beforeRef: { id: 'a', mimeType: 'image/png' },
      afterRef: { id: 'b', mimeType: 'image/png' },
      route: '/', viewport: { w: 1440, h: 900 }, workspaceHead: 'abc123',
    })).toBeUndefined();
    expect(normalizeEvidenceCapturedPayload({
      afterRef: { id: 'b', mimeType: 'image/png' },
      route: '/', viewport: { w: 0, h: 900 }, workspaceHead: 'abc123',
    })).toBeUndefined();
  });
});
