import { Injectable } from '@nestjs/common';
import { isAbsolute, normalize } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../db/database.service';

export interface CrewArtifactDto {
  id: string; runId: string; kind: string; relativeStoragePath: string; sha256: string;
  byteCount: number; metadata: Record<string, unknown>; retentionState: string; createdAt: number;
}

@Injectable()
export class CrewArtifactsRepository {
  constructor(private readonly database: DatabaseService) {}
  create(input: Omit<CrewArtifactDto, 'id' | 'retentionState' | 'createdAt'>): CrewArtifactDto {
    const path = normalize(input.relativeStoragePath);
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error('artifact storage path must be run-relative');
    }
    const dto = { ...input, relativeStoragePath: path, id: uuidv4(), retentionState: 'retained', createdAt: Date.now() };
    this.database.db.prepare(
      `INSERT INTO crew_artifacts
       (id, run_id, kind, relative_storage_path, sha256, byte_count, metadata_json, retention_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      dto.id, dto.runId, dto.kind, dto.relativeStoragePath, dto.sha256, dto.byteCount,
      JSON.stringify(dto.metadata), dto.retentionState, dto.createdAt,
    );
    return dto;
  }
  listByRun(runId: string): CrewArtifactDto[] {
    return this.database.db.prepare<ArtifactRow, [string]>(
      'SELECT * FROM crew_artifacts WHERE run_id = ? ORDER BY created_at, rowid',
    ).all(runId).map(toDto);
  }
  findById(id: string): CrewArtifactDto | null {
    const row = this.database.db.prepare<ArtifactRow, [string]>(
      'SELECT * FROM crew_artifacts WHERE id = ?',
    ).get(id);
    return row ? toDto(row) : null;
  }
}

interface ArtifactRow {
  id: string; run_id: string; kind: string; relative_storage_path: string; sha256: string;
  byte_count: number; metadata_json: string; retention_state: string; created_at: number;
}
function toDto(row: ArtifactRow): CrewArtifactDto {
  return {
    id: row.id, runId: row.run_id, kind: row.kind, relativeStoragePath: row.relative_storage_path,
    sha256: row.sha256, byteCount: row.byte_count,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    retentionState: row.retention_state, createdAt: row.created_at,
  };
}
