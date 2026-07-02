/** DTOs for the server-side directory browser (`GET /api/fs/dirs`). */

export interface DirEntryDto {
  name: string;
  /** Absolute path of the subdirectory. */
  path: string;
  /** True when the directory contains a `.git` entry (a git repo). */
  isGit: boolean;
}

export interface DirListingDto {
  /** Absolute path being listed. */
  current: string;
  /** Absolute parent path, or null at the filesystem root. */
  parent: string | null;
  /** Subdirectories, sorted by name. Noise (node_modules, dotfiles) filtered out. */
  entries: DirEntryDto[];
}

/** DTOs for the root-scoped file explorer API. */
export interface FileEntryDto {
  name: string;
  /** Relative path from the workspace root. */
  path: string;
  kind: 'file' | 'dir';
  size?: number;
  isSymlink?: boolean;
}

export interface FileListingDto {
  root: string;
  path: string;
  parent: string | null;
  entries: FileEntryDto[];
}

export type FileReadDto =
  | { path: string; content: string; encoding: 'utf8'; truncated: false; size: number }
  | { path: string; encoding: 'utf8'; truncated: true; size: number; binary?: false }
  | { path: string; binary: true; size: number };

export interface FileWriteDto {
  path: string;
  size: number;
}

export interface MakeDirDto {
  path: string;
}

export interface RenameDto {
  from: string;
  to: string;
}
