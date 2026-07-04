import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

/** Row in the `preferences` SQLite table. */
export interface PreferenceRow {
  key: string;
  value: string;
  updated_at: number;
}

/**
 * SQL CRUD for the `preferences` table. A preference is an arbitrary string key
 * mapped to an arbitrary string value (typically a JSON blob backing durable UI
 * state). Unlike `settings` there is no registry, env resolution, or encryption:
 * any key is accepted and the value is stored verbatim.
 */
@Injectable()
export class PreferencesRepository {
  constructor(private readonly database: DatabaseService) {}

  get(key: string): PreferenceRow | null {
    return (
      this.database.db
        .prepare<PreferenceRow, [string]>(
          'SELECT key, value, updated_at FROM preferences WHERE key = ?',
        )
        .get(key) ?? null
    );
  }

  set(key: string, value: string): PreferenceRow {
    const now = Date.now();
    this.database.db
      .prepare(
        'INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)\n' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, now);
    const row = this.get(key);
    if (!row) throw new Error(`preferences upsert failed for key ${key}`);
    return row;
  }

  delete(key: string): boolean {
    const result = this.database.db.prepare('DELETE FROM preferences WHERE key = ?').run(key);
    return result.changes > 0;
  }
}
