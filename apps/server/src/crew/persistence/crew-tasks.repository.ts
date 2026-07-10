import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../db/database.service';
import type { CrewTaskDto } from '../domain/crew.types';

@Injectable()
export class CrewTasksRepository {
  constructor(private readonly database: DatabaseService) {}
  create(input: { objective: string; projectPath: string; baseBranch?: string | null }): CrewTaskDto {
    const now = Date.now();
    const task: CrewTaskDto = {
      id: uuidv4(), objective: input.objective, projectPath: input.projectPath,
      baseBranch: input.baseBranch ?? null, createdAt: now, updatedAt: now,
    };
    this.database.db.prepare(
      `INSERT INTO crew_tasks (id, objective, project_path, base_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(task.id, task.objective, task.projectPath, task.baseBranch, now, now);
    return task;
  }
  findById(id: string): CrewTaskDto | null {
    const row = this.database.db.prepare<{
      id: string; objective: string; project_path: string; base_branch: string | null;
      created_at: number; updated_at: number;
    }, [string]>('SELECT * FROM crew_tasks WHERE id = ?').get(id);
    return row ? {
      id: row.id, objective: row.objective, projectPath: row.project_path,
      baseBranch: row.base_branch, createdAt: row.created_at, updatedAt: row.updated_at,
    } : null;
  }
}
