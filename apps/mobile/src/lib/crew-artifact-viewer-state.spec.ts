import { describe, expect, it } from 'vitest';
import {
  appendCrewArtifactPage,
  failCrewArtifactPage,
  initialCrewArtifactViewerState,
  startCrewArtifactPage,
} from './crew-artifact-viewer-state';

describe('Crew artifact viewer state', () => {
  it('uses server byte offsets while appending bounded pages through EOF', () => {
    const loading = startCrewArtifactPage(initialCrewArtifactViewerState);
    expect(loading).toMatchObject({ loading: true, error: null, nextOffset: 0 });
    expect(startCrewArtifactPage(loading)).toBe(loading);
    const first = appendCrewArtifactPage(loading, {
      text: 'é🙂', nextOffset: 6, eof: false,
    });
    expect(first).toEqual({
      text: 'é🙂', nextOffset: 6, eof: false, loading: false, error: null,
    });
    expect(first.text).toHaveLength(3);
    const complete = appendCrewArtifactPage(startCrewArtifactPage(first), {
      text: 'done', nextOffset: 10, eof: true,
    });
    expect(complete).toEqual({
      text: 'é🙂done', nextOffset: 10, eof: true, loading: false, error: null,
    });
  });

  it('keeps loaded text and offset across a retryable page error', () => {
    const loaded = {
      text: 'safe', nextOffset: 4, eof: false, loading: true, error: null,
    };
    const failed = failCrewArtifactPage(loaded, 'Could not load evidence');
    expect(failed).toEqual({
      text: 'safe', nextOffset: 4, eof: false, loading: false,
      error: 'Could not load evidence',
    });
    expect(startCrewArtifactPage(failed)).toEqual({ ...failed, loading: true, error: null });
  });
});
