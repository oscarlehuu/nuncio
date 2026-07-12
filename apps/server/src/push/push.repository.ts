import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

export interface PushTokenRow {
  token: string;
  platform: string | null;
  deviceName: string | null;
  deviceId: string | null;
  notificationsEnabled: boolean;
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

  registerForDevice(
    deviceId: string,
    token: string,
    platform: string,
    notificationsEnabled?: boolean,
  ): void {
    this.database.transaction(() => {
      const current = this.database.db
        .prepare<{ notifications_enabled: number }, [string]>(
          'SELECT notifications_enabled FROM push_tokens WHERE device_id = ?',
        )
        .get(deviceId);
      const enabled =
        notificationsEnabled ?? (current ? current.notifications_enabled !== 0 : true);
      this.database.db
        .prepare('DELETE FROM push_tokens WHERE device_id = ? AND token <> ?')
        .run(deviceId, token);
      this.database.db
        .prepare(
          `INSERT INTO push_tokens (
             token, platform, device_name, device_id, notifications_enabled, created_at
           ) VALUES (?, ?, NULL, ?, ?, ?)
           ON CONFLICT(token) DO UPDATE SET
             platform = excluded.platform,
             device_id = excluded.device_id,
             notifications_enabled = excluded.notifications_enabled`,
        )
        .run(token, platform, deviceId, enabled ? 1 : 0, Date.now());
    });
  }

  unregister(token: string): void {
    this.database.db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
  }

  list(): PushTokenRow[] {
    const rows = this.database.db
      .prepare<
        {
          token: string;
          platform: string | null;
          device_name: string | null;
          device_id: string | null;
          notifications_enabled: number;
        },
        []
      >(
        `SELECT token, platform, device_name, device_id, notifications_enabled
         FROM push_tokens`,
      )
      .all();
    return rows.map((r) => this.toRow(r));
  }

  listEnabled(): PushTokenRow[] {
    const rows = this.database.db
      .prepare<
        {
          token: string;
          platform: string | null;
          device_name: string | null;
          device_id: string | null;
          notifications_enabled: number;
        },
        []
      >(
        `SELECT p.token, p.platform, p.device_name, p.device_id, p.notifications_enabled
         FROM push_tokens p
         INNER JOIN devices d ON d.id = p.device_id
         WHERE p.notifications_enabled = 1
           AND d.revoked_at IS NULL`,
      )
      .all();
    return rows.map((r) => this.toRow(r));
  }

  listEnabledIncludingLegacyUnbound(): PushTokenRow[] {
    const rows = this.database.db
      .prepare<
        {
          token: string;
          platform: string | null;
          device_name: string | null;
          device_id: string | null;
          notifications_enabled: number;
        },
        []
      >(
        `SELECT p.token, p.platform, p.device_name, p.device_id, p.notifications_enabled
         FROM push_tokens p
         LEFT JOIN devices d ON d.id = p.device_id
         WHERE p.notifications_enabled = 1
           AND (p.device_id IS NULL OR (d.id IS NOT NULL AND d.revoked_at IS NULL))`,
      )
      .all();
    return rows.map((r) => this.toRow(r));
  }

  private toRow(row: {
    token: string;
    platform: string | null;
    device_name: string | null;
    device_id: string | null;
    notifications_enabled: number;
  }): PushTokenRow {
    return {
      token: row.token,
      platform: row.platform,
      deviceName: row.device_name,
      deviceId: row.device_id,
      notificationsEnabled: row.notifications_enabled !== 0,
    };
  }
}
