import { Injectable } from '@nestjs/common';
import { PreferencesRepository } from './preferences.repository';

/** Value returned to callers: the stored string plus its last-write timestamp. */
export interface PreferenceValue {
  value: string;
  updatedAt: number;
}

/**
 * Thin facade over the preferences repository. No registry, no masking, no
 * encryption — a preference is just a durable string keyed by an arbitrary
 * string. A missing key is a normal state (returns null), not an error.
 */
@Injectable()
export class PreferencesService {
  constructor(private readonly repo: PreferencesRepository) {}

  get(key: string): PreferenceValue | null {
    const row = this.repo.get(key);
    return row ? { value: row.value, updatedAt: row.updated_at } : null;
  }

  set(key: string, value: string): PreferenceValue {
    const row = this.repo.set(key, value);
    return { value: row.value, updatedAt: row.updated_at };
  }

  clear(key: string): void {
    this.repo.delete(key);
  }
}
