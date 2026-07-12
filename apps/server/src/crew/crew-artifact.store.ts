import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { DatabaseService } from '../db/database.service';
import { redactHighConfidenceSecrets } from '../git/git-sensitive-checkpoint-paths';
import { CrewNotFoundError, CrewValidationError } from './domain/crew-errors';
import { CrewArtifactsRepository, type CrewArtifactDto } from './persistence/crew-artifacts.repository';

export interface StoredCrewArtifact {
  artifact: CrewArtifactDto;
  preview: string;
  truncated: boolean;
}

@Injectable()
export class CrewArtifactStore {
  constructor(
    private readonly database: DatabaseService,
    private readonly artifacts: CrewArtifactsRepository,
  ) {}
  writeLog(input: {
    runId: string; kind: string; content: string; metadata?: Record<string, unknown>; previewBytes?: number;
  }): StoredCrewArtifact {
    if (this.database.closed) throw new Error('Crew artifact store is closed');
    if (!/^[A-Za-z0-9_-]+$/.test(input.runId)) throw new Error('invalid Crew run id');
    const previewBytes = input.previewBytes ?? 4096;
    if (!Number.isInteger(previewBytes) || previewBytes < 1 || previewBytes > 65_536) {
      throw new Error('previewBytes must be from 1 to 65536');
    }
    const redacted = Buffer.from(redactSecrets(input.content), 'utf8');
    const relativeStoragePath = `${input.runId}/${randomUUID()}.log`;
    const fullPath = this.safePath(relativeStoragePath);
    mkdirSync(resolve(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, redacted, { flag: 'wx', mode: 0o600 });
    try {
      const artifact = this.artifacts.create({
        runId: input.runId, kind: input.kind, relativeStoragePath,
        sha256: createHash('sha256').update(redacted).digest('hex'), byteCount: redacted.byteLength,
        metadata: redactMetadata(input.metadata ?? {}),
      });
      return {
        artifact,
        preview: redacted.subarray(0, utf8BoundaryEnd(redacted, 0, Math.min(redacted.byteLength, previewBytes)))
          .toString('utf8'),
        truncated: redacted.byteLength > previewBytes,
      };
    } catch (error) {
      rmSync(fullPath, { force: true });
      throw error;
    }
  }
  readRange(runId: string, artifactId: string, offset = 0, limit = 16_384) {
    if (!Number.isInteger(offset) || offset < 0) throw new CrewValidationError('offset must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 65_536) {
      throw new CrewValidationError('limit must be from 1 to 65536');
    }
    const { bytes } = this.verifiedBytes(runId, artifactId);
    if (offset > bytes.byteLength) throw new CrewValidationError('offset exceeds artifact byte count');
    if (offset < bytes.byteLength && isUtf8Continuation(bytes[offset]!)) {
      throw new CrewValidationError('offset must align to a UTF-8 character boundary');
    }
    const end = utf8BoundaryEnd(bytes, offset, Math.min(bytes.byteLength, offset + limit));
    if (end === offset && offset < bytes.byteLength) {
      throw new CrewValidationError('limit is too small for the next UTF-8 character');
    }
    return {
      artifactId, offset, nextOffset: end, eof: end >= bytes.byteLength,
      text: bytes.subarray(Math.min(offset, bytes.byteLength), end).toString('utf8'),
    };
  }
  assertIntegrity(runId: string, artifactId: string): void {
    this.verifiedBytes(runId, artifactId);
  }
  private verifiedBytes(runId: string, artifactId: string) {
    const artifact = this.artifacts.findById(artifactId);
    if (!artifact || artifact.runId !== runId) throw new CrewNotFoundError('CrewArtifact', artifactId);
    const bytes = readFileSync(this.safePath(artifact.relativeStoragePath));
    if (bytes.byteLength !== artifact.byteCount
      || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      throw new Error(`Crew artifact ${artifactId} integrity check failed`);
    }
    return { artifact, bytes };
  }
  private safePath(storedPath: string): string {
    const root = resolve(this.database.dataDir, 'crew-artifacts');
    const candidate = resolve(root, storedPath);
    const fromRoot = relative(root, candidate);
    if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('unsafe Crew artifact path');
    return candidate;
  }
}

function isUtf8Continuation(byte: number): boolean { return (byte & 0b1100_0000) === 0b1000_0000; }
function utf8BoundaryEnd(bytes: Buffer, start: number, proposedEnd: number): number {
  let end = proposedEnd;
  while (end > start && end < bytes.byteLength && isUtf8Continuation(bytes[end]!)) end -= 1;
  return end;
}

export function redactSecrets(value: string): string {
  return redactHighConfidenceSecrets(value)
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*[^\s]+/g, '$1=[REDACTED]');
}

function redactMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactMetadataValue(item)]));
}

function redactMetadataValue(value: unknown): unknown {
  if (typeof value === 'string') return redactHighConfidenceSecrets(value);
  if (Array.isArray(value)) return value.map(redactMetadataValue);
  if (value && typeof value === 'object') {
    return redactMetadata(value as Record<string, unknown>);
  }
  return value;
}
