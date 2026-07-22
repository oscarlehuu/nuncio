import { BadRequestException, Injectable } from '@nestjs/common';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  FileEntryDto,
  FileListingDto,
  FileReadDto,
  FileWriteDto,
  MakeDirDto,
  RenameDto,
} from './fs.types';

const SKIP_NAMES = new Set(['.git', 'node_modules']);
const MAX_FILE_BYTES = 1024 * 1024;

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function toRelative(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

@Injectable()
export class FileExplorerService {
  listEntries(root: string, path = ''): FileListingDto {
    const ctx = this.resolveExisting(root, path, { allowRoot: true });
    if (!statSync(ctx.real).isDirectory()) {
      throw new BadRequestException('Not a directory');
    }

    let dirents;
    try {
      dirents = readdirSync(ctx.real, { withFileTypes: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Cannot read directory: ${message}`);
    }

    const entries: FileEntryDto[] = [];
    for (const dirent of dirents) {
      if (SKIP_NAMES.has(dirent.name)) continue;
      const abs = resolve(ctx.real, dirent.name);
      let lstat;
      let real;
      let stats;
      try {
        lstat = lstatSync(abs);
        real = realpathSync.native(abs);
        if (!isInsideRoot(ctx.root, real)) continue;
        stats = statSync(real);
      } catch {
        continue;
      }
      const kind = stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : null;
      if (!kind) continue;
      entries.push({
        name: dirent.name,
        path: toRelative(ctx.root, resolve(ctx.real, dirent.name)),
        kind,
        ...(kind === 'file' ? { size: stats.size } : {}),
        ...(lstat.isSymbolicLink() ? { isSymlink: true } : {}),
      });
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parent = ctx.real === ctx.root ? null : toRelative(ctx.root, dirname(ctx.real));
    return { root: ctx.root, path: toRelative(ctx.root, ctx.real), parent, entries };
  }

  readFile(root: string, path: string): FileReadDto {
    const ctx = this.resolveExisting(root, path, { allowRoot: false });
    const stats = statSync(ctx.real);
    if (!stats.isFile()) throw new BadRequestException('Not a file');

    if (stats.size > MAX_FILE_BYTES) {
      return { path: toRelative(ctx.root, ctx.real), encoding: 'utf8', truncated: true, size: stats.size };
    }

    const buffer = readFileSync(ctx.real);
    if (buffer.includes(0)) {
      return { path: toRelative(ctx.root, ctx.real), binary: true, size: stats.size };
    }

    return {
      path: toRelative(ctx.root, ctx.real),
      content: buffer.toString('utf8'),
      encoding: 'utf8',
      truncated: false,
      size: stats.size,
    };
  }

  writeFile(root: string, path: string, content: string): FileWriteDto {
    const target = this.resolveForCreate(root, path, { parentMustExist: true });
    writeFileSync(target.abs, content ?? '', 'utf8');
    const stats = statSync(target.abs);
    return { path: toRelative(target.root, target.abs), size: stats.size };
  }

  makeDir(root: string, path: string): MakeDirDto {
    const target = this.resolveForCreate(root, path, { parentMustExist: false });
    if (existsSync(target.abs)) throw new BadRequestException('Path already exists');
    mkdirSync(target.abs, { recursive: true });
    return { path: toRelative(target.root, target.abs) };
  }

  rename(root: string, from: string, to: string): RenameDto {
    const source = this.resolveExisting(root, from, { allowRoot: false });
    const target = this.resolveForCreate(root, to, { parentMustExist: true });
    if (existsSync(target.abs)) throw new BadRequestException('Destination already exists');
    renameSync(source.real, target.abs);
    return { from: toRelative(source.root, source.real), to: toRelative(target.root, target.abs) };
  }

  deleteEntry(root: string, path: string): { path: string } {
    const target = this.resolveExisting(root, path, { allowRoot: false });
    rmSync(target.real, { recursive: true, force: false });
    return { path: toRelative(target.root, target.real) };
  }

  private validateRoot(root: string): string {
    const raw = (root ?? '').trim();
    if (!raw || !isAbsolute(raw)) throw new BadRequestException('Workspace root must be an absolute path');
    let realRoot: string;
    try {
      realRoot = realpathSync.native(resolve(raw));
    } catch {
      throw new BadRequestException('Workspace root does not exist');
    }
    let stats;
    try {
      stats = statSync(realRoot);
    } catch {
      throw new BadRequestException('Workspace root does not exist');
    }
    if (!stats.isDirectory()) throw new BadRequestException('Workspace root is not a directory');
    return realRoot;
  }

  private validateRelativePath(path: string): string {
    const rel = (path ?? '').trim();
    if (rel.includes('\0') || isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) {
      throw new BadRequestException('Path escapes workspace root');
    }
    return rel;
  }

  private resolveExisting(root: string, path: string, opts: { allowRoot: boolean }) {
    const realRoot = this.validateRoot(root);
    const rel = this.validateRelativePath(path);
    const abs = resolve(realRoot, rel || '.');
    let real: string;
    try {
      real = realpathSync.native(abs);
    } catch {
      throw new BadRequestException('Path does not exist');
    }
    if (!isInsideRoot(realRoot, real)) throw new BadRequestException('Path escapes workspace root');
    if (!opts.allowRoot && real === realRoot) throw new BadRequestException('Refusing to operate on workspace root');
    return { root: realRoot, abs, real };
  }

  private resolveForCreate(root: string, path: string, opts: { parentMustExist: boolean }) {
    const realRoot = this.validateRoot(root);
    const rel = this.validateRelativePath(path);
    if (!rel || rel === '.') throw new BadRequestException('Refusing to operate on workspace root');
    const abs = resolve(realRoot, rel);
    if (!isInsideRoot(realRoot, abs)) throw new BadRequestException('Path escapes workspace root');

    const canonicalTarget = this.resolveCanonicalCreateTarget(abs);
    if (!isInsideRoot(realRoot, canonicalTarget)) {
      throw new BadRequestException('Path escapes workspace root');
    }

    const parent = opts.parentMustExist ? dirname(abs) : this.findExistingAncestor(abs);
    let realParent: string;
    try {
      realParent = realpathSync.native(parent);
    } catch {
      throw new BadRequestException('Parent directory does not exist');
    }
    if (!isInsideRoot(realRoot, realParent)) throw new BadRequestException('Path escapes workspace root');
    if (opts.parentMustExist && !statSync(realParent).isDirectory()) {
      throw new BadRequestException('Parent is not a directory');
    }
    return { root: realRoot, abs };
  }

  private resolveCanonicalCreateTarget(abs: string): string {
    let candidate = abs;
    const seenLinks = new Set<string>();

    for (let depth = 0; depth < 40; depth += 1) {
      try {
        return realpathSync.native(candidate);
      } catch {
        // A missing target may still be a dangling symlink, which lstat can see.
      }

      try {
        if (lstatSync(candidate).isSymbolicLink()) {
          if (seenLinks.has(candidate)) throw new BadRequestException('Path contains a symlink loop');
          seenLinks.add(candidate);
          candidate = resolve(dirname(candidate), readlinkSync(candidate));
          continue;
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
      }

      const ancestor = this.findExistingAncestor(candidate);
      const realAncestor = realpathSync.native(ancestor);
      return resolve(realAncestor, relative(ancestor, candidate));
    }

    throw new BadRequestException('Path contains too many symlinks');
  }

  private findExistingAncestor(abs: string): string {
    let current = dirname(abs);
    while (!existsSync(current)) {
      const next = dirname(current);
      if (next === current) break;
      current = next;
    }
    return current;
  }
}
