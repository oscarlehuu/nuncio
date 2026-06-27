import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import type { SettingRow } from '../settings.types';

/**
 * SQL CRUD for the `settings` table. Deliberately dumb: no encryption, no env
 * resolution, no masking. The service layer is responsible for encrypting
 * secret-typed values before calling `set` and decrypting after `get`.
 */
@Injectable()
export class SettingsRepository {
  constructor(private readonly database: DatabaseService) {}

  get(key: string): SettingRow | null {
    return (
      this.database.db
        .prepare<SettingRow, [string]>('SELECT key, value, updated_at FROM settings WHERE key = ?')
        .get(key) ?? null
    );
  }

  list(): SettingRow[] {
    return this.database.db
      .prepare<SettingRow, []>('SELECT key, value, updated_at FROM settings ORDER BY key ASC')
      .all();
  }

  set(key: string, value: string): SettingRow {
    const now = Date.now();
    this.database.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)\n' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, now);
    const row = this.get(key);
    if (!row) throw new Error(`settings upsert failed for key ${key}`);
    return row;
  }

  delete(key: string): boolean {
    const result = this.database.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return result.changes > 0;
  }

  exists(key: string): boolean {
    const row = this.database.db
      .prepare<{ key: string }, [string]>('SELECT key FROM settings WHERE key = ?')
      .get(key);
    return row != null;
  }
}
