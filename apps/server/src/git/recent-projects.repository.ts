import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseService } from '../db/database.service';

const MAX_RECENT_PROJECTS = 20;

export interface RecentProjectDto {
  path: string;
  name: string;
  lastUsedAt: number;
}

@Injectable()
export class RecentProjectsRepository {
  constructor(private readonly database: DatabaseService) {}

  record(path: string): RecentProjectDto {
    const name = basename(path);
    const lastUsedAt = Date.now();
    this.database.db
      .prepare(
        `INSERT INTO recent_projects (path, name, last_used_at) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_used_at = excluded.last_used_at`,
      )
      .run(path, name, lastUsedAt);
    this.database.db
      .prepare(
        `DELETE FROM recent_projects WHERE path NOT IN (
           SELECT path FROM recent_projects ORDER BY last_used_at DESC LIMIT ?
         )`,
      )
      .run(MAX_RECENT_PROJECTS);
    return { path, name, lastUsedAt };
  }

  /** Most-recent-first; paths missing on disk are omitted (rows are kept). */
  list(): RecentProjectDto[] {
    const rows = this.database.db
      .prepare('SELECT path, name, last_used_at FROM recent_projects ORDER BY last_used_at DESC')
      .all() as Array<{ path: string; name: string; last_used_at: number }>;
    return rows
      .filter((row) => existsSync(row.path))
      .map((row) => ({ path: row.path, name: row.name, lastUsedAt: row.last_used_at }));
  }
}
