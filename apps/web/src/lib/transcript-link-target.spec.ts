import { describe, expect, it } from 'vitest';
import {
  isTranscriptCodePathLike,
  normalizeExternalHref,
  resolveTranscriptLinkTarget,
} from './transcript-link-target';

describe('transcript-link-target', () => {
  it('normalizes http and https URLs for external opening', () => {
    expect(normalizeExternalHref('https://example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeExternalHref('www.example.com/docs')).toBe('https://www.example.com/docs');
    expect(normalizeExternalHref('javascript:alert(1)')).toBeNull();
  });

  it('recognizes source paths without treating URLs as file paths', () => {
    expect(isTranscriptCodePathLike('apps/web/src/App.tsx')).toBe(true);
    expect(isTranscriptCodePathLike('./apps/web/src/App.tsx:12')).toBe(true);
    expect(isTranscriptCodePathLike('https://example.com/src/App.tsx')).toBe(false);
  });

  it('resolves relative and workspace-absolute file targets', () => {
    expect(resolveTranscriptLinkTarget('./apps/web/src/App.tsx:12', '/repo')).toEqual({
      kind: 'file',
      path: 'apps/web/src/App.tsx',
      line: 12,
    });
    expect(resolveTranscriptLinkTarget('/repo/apps/web/src/App.tsx#L4', '/repo')).toEqual({
      kind: 'file',
      path: 'apps/web/src/App.tsx',
      line: 4,
    });
    expect(resolveTranscriptLinkTarget('/other/apps/web/src/App.tsx', '/repo')).toEqual({
      kind: 'unknown',
    });
  });
});
