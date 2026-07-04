import { describe, it, expect } from 'vitest';
import { attachmentDataUrl, transcriptImageSrc } from './attachments';

describe('transcriptImageSrc', () => {
  it('resolves a disk-referenced image to its media endpoint', () => {
    expect(transcriptImageSrc({ mimeType: 'image/png', id: 'abc' }, 's1')).toBe(
      '/api/sessions/s1/media/abc',
    );
  });

  it('targets a remote hub base when provided', () => {
    expect(transcriptImageSrc({ mimeType: 'image/png', id: 'abc' }, 's1', 'http://host:3000')).toBe(
      'http://host:3000/api/sessions/s1/media/abc',
    );
  });

  it('falls back to an inline data URL when there is no id', () => {
    expect(transcriptImageSrc({ mimeType: 'image/jpeg', data: 'AAAA' }, 's1')).toBe(
      'data:image/jpeg;base64,AAAA',
    );
  });

  it('returns empty string when neither id nor data is present', () => {
    expect(transcriptImageSrc({ mimeType: 'image/png' }, 's1')).toBe('');
  });
});

describe('attachmentDataUrl', () => {
  it('builds a data URL from a compose-time image attachment', () => {
    expect(attachmentDataUrl({ kind: 'image', mimeType: 'image/png', data: 'ZZ' })).toBe(
      'data:image/png;base64,ZZ',
    );
  });
});
