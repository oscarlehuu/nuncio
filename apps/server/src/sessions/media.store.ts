import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseService } from '../db/database.service';

/** Best-effort image Content-Type from magic bytes — the ids are opaque, so the
 * type is sniffed rather than stored. Falls back to a generic binary type. */
export function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

/**
 * On-disk store for chat image attachments, under `<dataDir>/media/<session>/`.
 * Keeps base64 out of the transcript event log — the event holds only an opaque
 * id, and the bytes are served on demand. Ids are random 32-hex tokens; the
 * lookup rejects anything else so a request can never escape the session dir.
 */
@Injectable()
export class MediaStore {
  private readonly root: string;

  constructor(database: DatabaseService) {
    this.root = join(database.dataDir, 'media');
  }

  /** Persist a base64 image under the session; returns its opaque id. */
  write(sessionId: string, base64: string): string {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const id = randomBytes(16).toString('hex');
    writeFileSync(join(dir, id), Buffer.from(base64, 'base64'));
    return id;
  }

  /** Read a stored image, or null if the id is malformed or missing. */
  read(sessionId: string, mediaId: string): Buffer | null {
    if (!/^[a-f0-9]{32}$/.test(mediaId)) return null;
    const path = join(this.sessionDir(sessionId), mediaId);
    return existsSync(path) ? readFileSync(path) : null;
  }

  /** Drop every image for a session (called when the session is deleted). */
  deleteSession(sessionId: string): void {
    rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  private sessionDir(sessionId: string): string {
    // Session ids are server-generated, but sanitize to a single safe segment.
    return join(this.root, sessionId.replace(/[^a-zA-Z0-9_-]/g, ''));
  }
}
