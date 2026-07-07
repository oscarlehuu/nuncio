import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { githubCliToken, gitlabCliToken } from '../forges/cli-auth';
import { SettingsService } from '../settings/settings.service';
import { RecentProjectsRepository } from './recent-projects.repository';

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * Build the `git clone` argv, injecting the credential (if any) as a ONE-SHOT
 * `-c http.extraheader=...` override — ephemeral per-invocation, so it never
 * lands in the cloned repo's persisted `.git/config` or its origin URL. (Using
 * `git config` or embedding the token in the URL would persist it — never do
 * that.) No token → a plain `clone` with no credential surface.
 */
export function buildCloneArgs(url: string, dest: string, token: string | null): string[] {
  if (!token) return ['clone', url, dest];
  return ['-c', `http.extraheader=Authorization: Bearer ${token}`, 'clone', url, dest];
}

/**
 * Pick a collision-free directory name for a clone: the repo name, then `-2`,
 * `-3`, … until `taken(name)` is false. The name is validated to a single safe
 * path segment so a hostile `fullName` (`../x`, `a/b`) can never escape the
 * clone root. Pure — the caller supplies the `taken` predicate (fs check).
 */
export function pickCloneDirName(repoName: string, taken: (name: string) => boolean): string {
  const base = repoName.trim();
  if (!base || base.includes('/') || base.includes('\\') || base === '.' || base === '..' || base.includes('..')) {
    throw new BadRequestException(`Invalid repository name for clone: ${repoName}`);
  }
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  throw new BadRequestException(`Too many existing clones named ${base}`);
}

export interface CloneRequest {
  forgeId: string;
  fullName: string;
  cloneUrl: string;
}

export interface CloneResult {
  path: string;
}

/**
 * Clones a forge repository into NUNCIO_CLONE_DIR for the forge-aware picker.
 * Idempotent: an existing clone at the natural name whose origin matches the
 * requested URL is returned as-is (no re-clone, no error). A directory occupied
 * by an unrelated repo bumps the name (`-2`, `-3`). Every successful resolution
 * is recorded into recent_projects.
 */
@Injectable()
export class CloneService {
  /**
   * Test seam: run `git clone <url> <dest>`, injecting the credential (if any)
   * via a one-shot `-c http.extraheader` so a PRIVATE repo is cloneable without
   * the token ever persisting into the repo. Default shells out via Bun.
   */
  cloneExec: (url: string, dest: string, token: string | null) => Promise<void> = async (
    url,
    dest,
    token,
  ) => {
    const proc = Bun.spawn(['git', ...buildCloneArgs(url, dest, token)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      // Never surface the token in an error message.
      throw new BadRequestException(redactToken(stderr, token) || `git clone failed (${code})`);
    }
  };

  /**
   * Test seam: resolve the forge credential for the clone. Mirrors the provider
   * token resolution (settings token → CLI token) without a module cycle onto
   * ForgeRegistry. Null → a public/anonymous clone.
   */
  resolveToken: (forgeId: string) => Promise<string | null> = async (forgeId) => {
    if (forgeId === 'github') {
      return this.settings.resolve('GITHUB_TOKEN')?.trim() || (await githubCliToken());
    }
    if (forgeId === 'gitlab') {
      return this.settings.resolve('GITLAB_TOKEN')?.trim() || (await gitlabCliToken());
    }
    return null;
  };

  /** Test seam: does the repo at `dir` have `origin` matching `cloneUrl`? */
  remoteMatches: (dir: string, cloneUrl: string) => Promise<boolean> = async (dir, cloneUrl) => {
    const proc = Bun.spawn(['git', '-C', dir, 'remote', 'get-url', 'origin'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    if (code !== 0) return false;
    const url = (await new Response(proc.stdout).text()).trim();
    return normalizeRemote(url) === normalizeRemote(cloneUrl);
  };

  constructor(
    private readonly settings: SettingsService,
    private readonly recentProjects: RecentProjectsRepository,
  ) {}

  async clone(request: CloneRequest): Promise<CloneResult> {
    const cloneUrl = request.cloneUrl?.trim();
    const fullName = request.fullName?.trim();
    if (!cloneUrl) throw new BadRequestException('cloneUrl is required');
    if (!fullName) throw new BadRequestException('fullName is required');

    const cloneDir = this.resolveCloneDir();
    const repoName = fullName.split('/').pop() ?? fullName;

    // git clone does NOT create missing parent directories — ensure the clone
    // root exists before choosing a destination, or the FIRST clone into a fresh
    // NUNCIO_CLONE_DIR (e.g. the default ~/nuncio/projects) fails.
    mkdirSync(cloneDir, { recursive: true });

    // Idempotency: if the natural-name dir already holds a git repo whose origin
    // matches, return it without re-cloning. An unrelated dir at that name is a
    // collision → bump. A non-git dir at that name is also a collision → bump.
    const naturalDir = join(cloneDir, sanitizeSegment(repoName, repoName));
    if (existsSync(join(naturalDir, '.git')) && (await this.remoteMatches(naturalDir, cloneUrl))) {
      return this.record(naturalDir);
    }

    const dirName = pickCloneDirName(repoName, (name) => existsSync(join(cloneDir, name)));
    const dest = join(cloneDir, dirName);
    const token = await this.resolveToken(request.forgeId);
    await this.cloneExec(cloneUrl, dest, token);
    return this.record(dest);
  }

  private record(path: string): CloneResult {
    this.recentProjects.record(path);
    return { path };
  }

  private resolveCloneDir(): string {
    const configured = this.settings.resolve('NUNCIO_CLONE_DIR')?.trim() || '~/nuncio/projects';
    return expandHome(configured);
  }
}

/** Validate a single path segment; delegates the real check to pickCloneDirName. */
function sanitizeSegment(name: string, original: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new BadRequestException(`Invalid repository name for clone: ${original}`);
  }
  return trimmed;
}

/** Strip a leaked token out of a git error string before it reaches a caller. */
function redactToken(text: string, token: string | null): string {
  if (!token) return text;
  return text.split(token).join('***');
}

/** Normalize a remote URL for comparison (strip trailing .git and slashes). */
function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}
