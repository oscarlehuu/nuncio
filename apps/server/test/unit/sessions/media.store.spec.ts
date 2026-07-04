import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaStore, sniffImageMime } from '../../../src/sessions/media.store';
import type { DatabaseService } from '../../../src/db/database.service';

const dataDir = mkdtempSync(join(tmpdir(), 'nuncio-media-'));
const store = new MediaStore({ dataDir } as unknown as DatabaseService);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('MediaStore', () => {
  it('round-trips a written image by its id', () => {
    const bytes = Buffer.from('hello-image');
    const id = store.write('sess-1', bytes.toString('base64'));
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(store.read('sess-1', id)?.equals(bytes)).toBe(true);
  });

  it('scopes images per session (another session cannot read them)', () => {
    const id = store.write('owner', Buffer.from('secret').toString('base64'));
    expect(store.read('intruder', id)).toBeNull();
  });

  it('rejects malformed ids and path-traversal attempts', () => {
    expect(store.read('sess-1', 'not-a-valid-id')).toBeNull();
    expect(store.read('sess-1', '../../etc/passwd')).toBeNull();
    expect(store.read('sess-1', 'a'.repeat(31))).toBeNull();
  });

  it('drops a session’s images on delete', () => {
    const id = store.write('doomed', Buffer.from('bye').toString('base64'));
    expect(store.read('doomed', id)).not.toBeNull();
    store.deleteSession('doomed');
    expect(store.read('doomed', id)).toBeNull();
  });
});

describe('sniffImageMime', () => {
  it('detects common formats and falls back to octet-stream', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
    expect(sniffImageMime(Buffer.from('nope'))).toBe('application/octet-stream');
  });
});
