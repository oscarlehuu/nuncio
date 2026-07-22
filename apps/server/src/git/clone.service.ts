import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
 * that.) No credential → a plain `clone` with no credential surface.
 */
export interface CloneCredential {
  forgeId: string;
  token: string;
}

export function buildCloneArgs(url: string, dest: string, credential: CloneCredential | null): string[] {
  const header = credential ? buildCloneAuthHeader(credential.forgeId, credential.token) : null;
  if (!header) return ['clone', url, dest];
  return ['-c', `http.extraheader=${header}`, 'clone', url, dest];
}

export function buildCloneAuthHeader(forgeId: string, token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  if (forgeId === 'github') {
    return `Authorization: basic ${Buffer.from(`x-access-token:${trimmed}`).toString('base64')}`;
  }
  if (forgeId === 'gitlab') {
    return `Authorization: basic ${Buffer.from(`oauth2:${trimmed}`).toString('base64')}`;
  }
  return null;
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
  private?: boolean;
}

export interface CloneResult {
  path: string;
}

interface CloneReservationMetadata {
  schemaVersion: 1;
  reservationId: string;
  pid: number;
  processStartTime: string;
  createdAtMs: number;
  leaseUpdatedAtMs: number;
  destinationName: string;
  cloneUrlHash: string;
}

interface CloneDestinationReservation {
  dest: string;
  cloneDest: string;
  marker: string;
  metadata: CloneReservationMetadata;
}

interface CloneReclaimLease {
  dir: string;
  metadata: CloneReservationMetadata;
}

type CloneDestinationResolution =
  | { kind: 'existing'; dest: string }
  | { kind: 'reserved'; reservation: CloneDestinationReservation };

type CloneCandidateState = 'available' | 'taken' | { existing: string };

type ReservationRecovery = 'blocked' | 'reclaimed' | { existing: string };

/**
 * Clones a forge repository into NUNCIO_CLONE_DIR for the forge-aware picker.
 * Idempotent: an existing clone at the natural name whose origin matches the
 * requested URL is returned as-is (no re-clone, no error). A directory occupied
 * by an unrelated repo bumps the name (`-2`, `-3`). Every successful resolution
 * is recorded into recent_projects.
 */
@Injectable()
export class CloneService {
  /** Test seam: pause after candidate selection, before the atomic on-disk claim. */
  beforeDestinationReservation: ((dest: string) => Promise<void>) | null = null;

  /** Test seam: resolve an OS process-start identity; null means definitely absent. */
  processStartTimeLookup: (pid: number) => Promise<string | null | undefined> =
    defaultProcessStartTimeLookup;

  /**
   * Test seam: run `git clone <url> <dest>`, injecting the credential (if any)
   * via a one-shot `-c http.extraheader` so a PRIVATE repo is cloneable without
   * the token ever persisting into the repo. Default shells out via Bun.
   */
  cloneExec: (url: string, dest: string, credential: CloneCredential | null) => Promise<void> = async (
    url,
    dest,
    credential,
  ) => {
    const proc = Bun.spawn(['git', ...buildCloneArgs(url, dest, credential)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      // Never surface the token in an error message.
      throw new BadRequestException(redactToken(stderr, credential?.token ?? null) || `git clone failed (${code})`);
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

    const resolution = await this.reserveCloneDestination(cloneDir, repoName, cloneUrl);
    if (resolution.kind === 'existing') return this.record(resolution.dest);

    const { reservation } = resolution;
    try {
      await this.cloneWithPrivacy(
        request.forgeId,
        cloneUrl,
        reservation,
        request.private === false,
      );
      this.publishReservation(reservation);
      this.removeOwnedReservation(reservation);
    } catch (error) {
      try {
        this.removeOwnedReservation(reservation);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Clone failed and reservation cleanup also failed for ${reservation.dest}`,
        );
      }
      throw error;
    }
    return this.record(reservation.dest);
  }

  private async reserveCloneDestination(
    cloneDir: string,
    repoName: string,
    cloneUrl: string,
  ): Promise<CloneDestinationResolution> {
    const base = sanitizeSegment(repoName, repoName);
    for (let index = 1; index <= 999; index += 1) {
      const dirName = index === 1 ? base : `${base}-${index}`;
      const candidate = await this.prepareCloneCandidate(cloneDir, dirName, cloneUrl, index === 1);
      if (typeof candidate === 'object') return { kind: 'existing', dest: candidate.existing };
      if (candidate === 'taken') continue;

      const dest = join(cloneDir, dirName);
      if (this.beforeDestinationReservation) {
        await this.beforeDestinationReservation(dest);
      }

      const reservation = await this.createReservation(cloneDir, dirName, cloneUrl);
      if (reservation) return { kind: 'reserved', reservation };
    }
    throw new BadRequestException(`Too many existing clones named ${base}`);
  }

  private async prepareCloneCandidate(
    cloneDir: string,
    dirName: string,
    cloneUrl: string,
    allowExistingMatch: boolean,
  ): Promise<CloneCandidateState> {
    const marker = cloneReservationMarker(cloneDir, dirName);
    if (existsSync(marker)) {
      const recovery = await this.recoverStaleReservation(
        cloneDir,
        dirName,
        cloneUrl,
        allowExistingMatch,
      );
      if (typeof recovery === 'object') return recovery;
      if (recovery === 'blocked') return 'taken';
    }

    const dest = join(cloneDir, dirName);
    if (
      allowExistingMatch
      && !existsSync(marker)
      && existsSync(join(dest, '.git'))
      && (await this.remoteMatches(dest, cloneUrl))
      && !existsSync(marker)
    ) {
      return { existing: dest };
    }
    return existsSync(dest) || existsSync(marker) ? 'taken' : 'available';
  }

  private async createReservation(
    cloneDir: string,
    dirName: string,
    cloneUrl: string,
  ): Promise<CloneDestinationReservation | null> {
    const processStartTime = await this.processStartTimeLookup(process.pid);
    if (!processStartTime) {
      throw new BadRequestException('Unable to verify clone reservation process ownership');
    }

    const marker = cloneReservationMarker(cloneDir, dirName);
    const dest = join(cloneDir, dirName);
    const cloneDest = join(marker, cloneReservationWorktreeName);
    const now = Date.now();
    const metadata: CloneReservationMetadata = {
      schemaVersion: 1,
      reservationId: randomUUID(),
      pid: process.pid,
      processStartTime,
      createdAtMs: now,
      leaseUpdatedAtMs: now,
      destinationName: dirName,
      cloneUrlHash: hashCloneUrl(cloneUrl),
    };

    try {
      mkdirSync(marker);
    } catch (error) {
      if (isAlreadyExistsError(error)) return null;
      throw error;
    }

    try {
      writeReservationMetadata(marker, metadata);
      mkdirSync(cloneDest);
      return { dest, cloneDest, marker, metadata };
    } catch (error) {
      rmSync(marker, { recursive: true, force: true });
      if (isAlreadyExistsError(error)) return null;
      throw error;
    }
  }

  private async recoverStaleReservation(
    cloneDir: string,
    dirName: string,
    cloneUrl: string,
    allowExistingMatch: boolean,
  ): Promise<ReservationRecovery> {
    const marker = cloneReservationMarker(cloneDir, dirName);
    const metadata = readReservationMetadata(marker, dirName);
    if (!metadata || (await this.reservationOwnerState(metadata)) !== 'stale') return 'blocked';

    const reclaimLease = await this.acquireReclaimLease(marker, dirName, cloneUrl);
    if (!reclaimLease) return 'blocked';

    let markerRemoved = false;
    try {
      const current = readReservationMetadata(marker, dirName);
      if (
        !current
        || current.reservationId !== metadata.reservationId
        || (await this.reservationOwnerState(current)) !== 'stale'
      ) {
        return 'blocked';
      }

      const dest = join(cloneDir, dirName);
      if (
        allowExistingMatch
        && existsSync(join(dest, '.git'))
        && (await this.remoteMatches(dest, cloneUrl))
      ) {
        this.assertReclaimLease(marker, reclaimLease, metadata.reservationId);
        rmSync(marker, { recursive: true, force: true });
        markerRemoved = true;
        return { existing: dest };
      }

      // In-progress clone data lives under the marker, never at the published
      // destination. Removing a proved-dead marker therefore cannot remove an
      // unrelated checkout or directory that appeared at the final path.
      this.assertReclaimLease(marker, reclaimLease, metadata.reservationId);
      rmSync(marker, { recursive: true, force: true });
      markerRemoved = true;
      return 'reclaimed';
    } finally {
      if (!markerRemoved) this.releaseReclaimLease(reclaimLease);
    }
  }

  private async reservationOwnerState(
    metadata: CloneReservationMetadata,
  ): Promise<'live' | 'stale' | 'unknown'> {
    try {
      const actualStart = await this.processStartTimeLookup(metadata.pid);
      if (actualStart === null) return 'stale';
      if (!actualStart) return 'unknown';
      return actualStart === metadata.processStartTime ? 'live' : 'stale';
    } catch {
      return 'unknown';
    }
  }

  private async acquireReclaimLease(
    marker: string,
    destinationName: string,
    cloneUrl: string,
  ): Promise<CloneReclaimLease | null> {
    const processStartTime = await this.processStartTimeLookup(process.pid);
    if (!processStartTime) return null;

    const dir = join(marker, cloneReclaimLeaseName);
    try {
      mkdirSync(dir);
    } catch (error) {
      if (isPathMissingError(error)) return null;
      if (!isAlreadyExistsError(error)) throw error;
      if (!(await this.removeProvenStaleReclaimLease(dir, destinationName))) return null;
      try {
        mkdirSync(dir);
      } catch (retryError) {
        if (isAlreadyExistsError(retryError) || isPathMissingError(retryError)) return null;
        throw retryError;
      }
    }

    const now = Date.now();
    const metadata: CloneReservationMetadata = {
      schemaVersion: 1,
      reservationId: randomUUID(),
      pid: process.pid,
      processStartTime,
      createdAtMs: now,
      leaseUpdatedAtMs: now,
      destinationName,
      cloneUrlHash: hashCloneUrl(cloneUrl),
    };
    try {
      writeReservationMetadata(dir, metadata);
      return { dir, metadata };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  private async removeProvenStaleReclaimLease(
    dir: string,
    destinationName: string,
  ): Promise<boolean> {
    const observed = readReservationMetadata(dir, destinationName);
    if (!observed || (await this.reservationOwnerState(observed)) !== 'stale') return false;

    // Re-read immediately before the atomic move. Another reclaimer may have
    // replaced the stale lease while process ownership was being resolved.
    const current = readReservationMetadata(dir, destinationName);
    if (!sameReservationMetadata(current, observed)) return false;

    const retiredDir = `${dir}.stale-${randomUUID()}`;
    try {
      renameSync(dir, retiredDir);
    } catch (error) {
      if (isAlreadyExistsError(error) || isPathMissingError(error)) return false;
      throw error;
    }

    const retired = readReservationMetadata(retiredDir, destinationName);
    if (!sameReservationMetadata(retired, observed)) {
      restoreReclaimLease(retiredDir, dir);
      return false;
    }

    rmSync(retiredDir, { recursive: true, force: true });
    return true;
  }

  private assertReclaimLease(
    marker: string,
    lease: CloneReclaimLease,
    staleReservationId: string,
  ): void {
    const destinationName = lease.metadata.destinationName;
    const markerMetadata = readReservationMetadata(marker, destinationName);
    const leaseMetadata = readReservationMetadata(lease.dir, destinationName);
    if (
      markerMetadata?.reservationId !== staleReservationId
      || !sameReservationMetadata(leaseMetadata, lease.metadata)
    ) {
      throw new BadRequestException('Clone reservation ownership changed during recovery');
    }
  }

  private releaseReclaimLease(lease: CloneReclaimLease): void {
    const current = readReservationMetadata(lease.dir, lease.metadata.destinationName);
    if (sameReservationMetadata(current, lease.metadata)) {
      rmSync(lease.dir, { recursive: true, force: true });
    }
  }

  private publishReservation(reservation: CloneDestinationReservation): void {
    this.assertOwnReservation(reservation);
    if (existsSync(reservation.dest)) {
      throw new BadRequestException(`Clone destination became occupied: ${reservation.dest}`);
    }
    renameSync(reservation.cloneDest, reservation.dest);
  }

  private removeOwnedReservation(reservation: CloneDestinationReservation): void {
    if (!existsSync(reservation.marker)) return;
    this.assertOwnReservation(reservation);
    rmSync(reservation.marker, { recursive: true, force: true });
  }

  private assertOwnReservation(reservation: CloneDestinationReservation): void {
    const current = readReservationMetadata(reservation.marker, reservation.metadata.destinationName);
    if (
      current?.reservationId !== reservation.metadata.reservationId
      || current.pid !== reservation.metadata.pid
      || current.processStartTime !== reservation.metadata.processStartTime
    ) {
      throw new BadRequestException('Clone reservation ownership changed before cleanup');
    }
  }

  private resetReservedDestination(reservation: CloneDestinationReservation): void {
    this.assertOwnReservation(reservation);
    rmSync(reservation.cloneDest, { recursive: true, force: true });
    mkdirSync(reservation.cloneDest);
  }

  private async cloneWithPrivacy(
    forgeId: string,
    cloneUrl: string,
    reservation: CloneDestinationReservation,
    publicRepo: boolean,
  ): Promise<void> {
    if (publicRepo) {
      try {
        await this.cloneExec(cloneUrl, reservation.cloneDest, null);
        return;
      } catch (error) {
        // The retry clears only this marker-owned worktree. The final destination
        // is not published until a clone has completed successfully.
        this.resetReservedDestination(reservation);
        const token = await this.resolveToken(forgeId);
        if (!token) throw error;
        await this.cloneAuthenticated(forgeId, cloneUrl, reservation.cloneDest, token);
        return;
      }
    }

    const token = await this.resolveToken(forgeId);
    await this.cloneAuthenticated(forgeId, cloneUrl, reservation.cloneDest, token);
  }

  private async cloneAuthenticated(
    forgeId: string,
    cloneUrl: string,
    dest: string,
    token: string | null,
  ): Promise<void> {
    const credential = token ? { forgeId, token } : null;
    try {
      await this.cloneExec(cloneUrl, dest, credential);
    } catch (error) {
      if (credential && isInvalidCredentialError(error)) {
        throw new BadRequestException(`${forgeName(forgeId)} token rejected - ${reauthHint(forgeId)}`);
      }
      throw error;
    }
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

const cloneReservationFileName = 'reservation.json';
const cloneReservationWorktreeName = 'checkout';
const cloneReclaimLeaseName = '.reclaiming';

function cloneReservationMarker(cloneDir: string, dirName: string): string {
  return join(cloneDir, `.${dirName}.nuncio-clone-reservation`);
}

function hashCloneUrl(cloneUrl: string): string {
  return createHash('sha256').update(cloneUrl).digest('hex');
}

function writeReservationMetadata(marker: string, metadata: CloneReservationMetadata): void {
  writeFileSync(join(marker, cloneReservationFileName), `${JSON.stringify(metadata)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

function readReservationMetadata(
  marker: string,
  expectedDestinationName?: string,
): CloneReservationMetadata | null {
  try {
    const value = JSON.parse(
      readFileSync(join(marker, cloneReservationFileName), 'utf8'),
    ) as Record<string, unknown>;
    if (
      value.schemaVersion !== 1
      || typeof value.reservationId !== 'string'
      || value.reservationId.length === 0
      || value.reservationId.length > 200
      || !Number.isInteger(value.pid)
      || (value.pid as number) <= 0
      || typeof value.processStartTime !== 'string'
      || value.processStartTime.length === 0
      || value.processStartTime.length > 500
      || !Number.isSafeInteger(value.createdAtMs)
      || (value.createdAtMs as number) <= 0
      || !Number.isSafeInteger(value.leaseUpdatedAtMs)
      || (value.leaseUpdatedAtMs as number) < (value.createdAtMs as number)
      || typeof value.destinationName !== 'string'
      || value.destinationName.length === 0
      || value.destinationName.length > 500
      || (expectedDestinationName !== undefined && value.destinationName !== expectedDestinationName)
      || typeof value.cloneUrlHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.cloneUrlHash)
    ) {
      return null;
    }
    return value as unknown as CloneReservationMetadata;
  } catch {
    return null;
  }
}

function sameReservationMetadata(
  left: CloneReservationMetadata | null,
  right: CloneReservationMetadata,
): boolean {
  return left !== null
    && left.schemaVersion === right.schemaVersion
    && left.reservationId === right.reservationId
    && left.pid === right.pid
    && left.processStartTime === right.processStartTime
    && left.createdAtMs === right.createdAtMs
    && left.leaseUpdatedAtMs === right.leaseUpdatedAtMs
    && left.destinationName === right.destinationName
    && left.cloneUrlHash === right.cloneUrlHash;
}

function restoreReclaimLease(retiredDir: string, activeDir: string): void {
  try {
    renameSync(retiredDir, activeDir);
  } catch (error) {
    // If another claimant already created the active path, preserve both
    // directories rather than deleting ownership evidence we cannot prove.
    if (isAlreadyExistsError(error) || isPathMissingError(error)) return;
    throw error;
  }
}

async function defaultProcessStartTimeLookup(pid: number): Promise<string | null | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const initialLiveness = processLiveness(pid);
  if (initialLiveness === 'dead') return null;

  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closingParen = stat.lastIndexOf(')');
      const fields = closingParen >= 0 ? stat.slice(closingParen + 1).trim().split(/\s+/) : [];
      const startTicks = fields[19];
      return startTicks ? `linux:${startTicks}` : undefined;
    } catch {
      return processLiveness(pid) === 'dead' ? null : undefined;
    }
  }

  const command = process.platform === 'win32'
    ? [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ]
    : ['ps', '-o', 'lstart=', '-p', String(pid)];

  try {
    const child = Bun.spawn(command, {
      stdout: 'pipe',
      stderr: 'ignore',
      env: process.platform === 'win32' ? process.env : { ...process.env, LC_ALL: 'C' },
    });
    const [code, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    if (code !== 0) return processLiveness(pid) === 'dead' ? null : undefined;
    const normalized = output.trim().replace(/\s+/g, ' ');
    if (!normalized) return processLiveness(pid) === 'dead' ? null : undefined;
    return `${process.platform}:${normalized}`;
  } catch {
    return processLiveness(pid) === 'dead' ? null : undefined;
  }
}

function processLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (isErrorCode(error, 'ESRCH')) return 'dead';
    if (isErrorCode(error, 'EPERM')) return 'alive';
    return 'unknown';
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return isErrorCode(error, 'EEXIST');
}

function isPathMissingError(error: unknown): boolean {
  return isErrorCode(error, 'ENOENT');
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Strip a leaked token out of a git error string before it reaches a caller. */
function redactToken(text: string, token: string | null): string {
  if (!token) return text;
  return text.split(token).join('***');
}

function isInvalidCredentialError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /invalid credentials|authentication failed/i.test(text);
}

function forgeName(forgeId: string): string {
  if (forgeId === 'github') return 'GitHub';
  if (forgeId === 'gitlab') return 'GitLab';
  return 'Forge';
}

function reauthHint(forgeId: string): string {
  if (forgeId === 'github') return 'run gh auth login / check Settings';
  if (forgeId === 'gitlab') return 'run glab auth login / check Settings';
  return 'check Settings';
}

/** Normalize a remote URL for comparison (strip trailing .git and slashes). */
function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}
