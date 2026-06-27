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
