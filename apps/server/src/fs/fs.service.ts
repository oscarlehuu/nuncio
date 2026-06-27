import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DirEntryDto, DirListingDto } from './fs.types';

/**
 * Directories filtered from listings — never useful as a project root and
 * either huge (node_modules) or internal (.git).
 */
const SKIP_NAMES = new Set(['node_modules', '.git']);

/**
 * Server-side directory browser. Lets the frontend navigate the host
 * filesystem and pick an absolute path — necessary because browsers cannot
 * expose host filesystem paths (security sandbox), and the primary client is
 * an iPhone PWA where the File System Access API is unavailable.
 *
 * Runs as the server process user, so it sees whatever the user has perms to
 * see — appropriate for a self-hosted, single-user deployment.
 */
@Injectable()
export class FsService {
  listDirectories(rawPath: string): DirListingDto {
    const current = this.resolvePath(rawPath);
    if (!existsSync(current)) {
      throw new BadRequestException(`No such directory: ${current}`);
    }
    let isDir = false;
    try {
      isDir = statSync(current).isDirectory();
    } catch {
      // unreadable — treat as not a directory
    }
    if (!isDir) {
      throw new BadRequestException(`Not a directory: ${current}`);
    }

    const entries: DirEntryDto[] = [];
    let dirents;
    try {
      dirents = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      // Permission denied or similar — surface as a 400 with the reason.
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Cannot read directory ${current}: ${message}`);
    }

    for (const dirent of dirents) {
      const name = dirent.name;
      if (!dirent.isDirectory()) continue;
      if (name.startsWith('.') || SKIP_NAMES.has(name)) continue;
      const abs = join(current, name);
      let isGit = false;
      try {
        isGit = existsSync(join(abs, '.git'));
      } catch {
        // ignore — treat as non-git
      }
      entries.push({ name, path: abs, isGit });
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    const parent = current === '/' ? null : dirname(current);
    return { current, parent, entries };
  }

  /** Resolve `~`, empty, and relative paths to an absolute path. */
  private resolvePath(rawPath: string): string {
    const trimmed = (rawPath ?? '').trim();
    if (!trimmed || trimmed === '~') return homedir();
    if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
    if (!isAbsolute(trimmed)) return resolve(trimmed);
    return resolve(trimmed);
  }
}

/** Re-exported for callers that only need the basename helper. */
export function dirName(path: string): string {
  return basename(path);
}
