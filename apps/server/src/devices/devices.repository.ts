import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

export interface DeviceRow {
  id: string;
  name: string;
  platform: string | null;
  secret_hash: string;
  prev_secret_hash: string | null;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export interface NewDeviceRow {
  id: string;
  name: string;
  platform: string | null;
  secretHash: string;
  createdAt: number;
}

@Injectable()
export class DevicesRepository {
  constructor(private readonly database: DatabaseService) {}

  insert(row: NewDeviceRow): void {
    this.database.db
      .prepare(
        `INSERT INTO devices (id, name, platform, secret_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.name, row.platform, row.secretHash, row.createdAt);
  }

  findById(id: string): DeviceRow | null {
    return (
      this.database.db
        .prepare<DeviceRow, [string]>('SELECT * FROM devices WHERE id = ?')
        .get(id) ?? null
    );
  }

  list(): DeviceRow[] {
    return this.database.db
      .prepare<DeviceRow, []>('SELECT * FROM devices ORDER BY last_seen_at DESC')
      .all();
  }

  revoke(id: string, ts: number): void {
    this.database.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(ts, id);
  }

  touchLastSeen(id: string, ts: number): void {
    this.database.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(ts, id);
  }

  setSecret(id: string, secretHash: string, prevSecretHash: string | null): void {
    this.database.db
      .prepare('UPDATE devices SET secret_hash = ?, prev_secret_hash = ? WHERE id = ?')
      .run(secretHash, prevSecretHash, id);
  }

  clearPrevSecret(id: string): void {
    this.database.db.prepare('UPDATE devices SET prev_secret_hash = NULL WHERE id = ?').run(id);
  }
}
