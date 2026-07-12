import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../db/database.service';
import type { CrewProfileDefinition, CrewProfileDto } from '../domain/crew.types';
import { CrewNotFoundError, CrewProfileRevisionConflictError } from '../domain/crew-errors';

interface ProfileRow {
  id: string; name: string; preset_id: 'quality'; definition_json: string;
  revision: number; created_at: number; updated_at: number;
}

function toDto(row: ProfileRow): CrewProfileDto {
  return {
    id: row.id, name: row.name, presetId: row.preset_id,
    definition: JSON.parse(row.definition_json) as CrewProfileDefinition,
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

@Injectable()
export class CrewProfilesRepository {
  constructor(private readonly database: DatabaseService) {}
  create(input: { name: string; presetId: 'quality'; definition: unknown }): CrewProfileDto {
    const now = Date.now();
    const row: ProfileRow = {
      id: uuidv4(), name: input.name, preset_id: input.presetId,
      definition_json: JSON.stringify(input.definition), revision: 1, created_at: now, updated_at: now,
    };
    this.database.db.prepare(
      `INSERT INTO crew_profiles
       (id, name, preset_id, definition_json, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.name, row.preset_id, row.definition_json, row.revision, now, now);
    return toDto(row);
  }
  update(id: string, revision: number, input: { name?: string; definition?: unknown }): CrewProfileDto {
    const current = this.findRow(id);
    if (!current) throw new CrewNotFoundError('CrewProfile', id);
    const row = this.database.db.prepare<ProfileRow, [string, string, number, string, number]>(
      `UPDATE crew_profiles SET name = ?, definition_json = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ? RETURNING *`,
    ).get(
      input.name ?? current.name,
      input.definition === undefined ? current.definition_json : JSON.stringify(input.definition),
      Date.now(), id, revision,
    );
    if (!row) {
      const latest = this.findById(id);
      if (!latest) throw new CrewNotFoundError('CrewProfile', id);
      throw new CrewProfileRevisionConflictError(id, revision, latest);
    }
    return toDto(row);
  }
  findById(id: string): CrewProfileDto | null {
    const row = this.findRow(id); return row ? toDto(row) : null;
  }
  list(): CrewProfileDto[] {
    return this.database.db.prepare<ProfileRow, []>(
      'SELECT * FROM crew_profiles ORDER BY name COLLATE NOCASE, id',
    ).all().map(toDto);
  }
  delete(id: string): boolean {
    return this.database.db.prepare('DELETE FROM crew_profiles WHERE id = ?').run(id).changes > 0;
  }
  private findRow(id: string): ProfileRow | null {
    return this.database.db.prepare<ProfileRow, [string]>(
      'SELECT * FROM crew_profiles WHERE id = ?',
    ).get(id) ?? null;
  }
}
