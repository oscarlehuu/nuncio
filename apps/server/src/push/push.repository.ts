import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

export interface PushTokenRow {
  token: string;
  platform: string | null;
  deviceName: string | null;
}

@Injectable()
export class PushRepository {
  constructor(private readonly database: DatabaseService) {}

  register(token: string, platform?: string, deviceName?: string): void {
    this.database.db
      .prepare(
        `INSERT INTO push_tokens (token, platform, device_name, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, device_name = excluded.device_name`,
      )
      .run(token, platform ?? null, deviceName ?? null, Date.now());
  }

  unregister(token: string): void {
    this.database.db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
  }

  list(): PushTokenRow[] {
    const rows = this.database.db
      .prepare<{ token: string; platform: string | null; device_name: string | null }, []>(
        'SELECT token, platform, device_name FROM push_tokens',
      )
      .all();
    return rows.map((r) => ({ token: r.token, platform: r.platform, deviceName: r.device_name }));
  }
}
