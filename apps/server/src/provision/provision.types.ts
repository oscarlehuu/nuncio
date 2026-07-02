/** A provisioning payload pushed from one nuncio to another (same owner). */
export interface ProvisionPayload {
  /** Pi agent config files, by filename (auth.json / models.json / settings.json). */
  piAgent?: Record<string, string>;
  /** Nuncio settings (registered, non-path keys only — paths are machine-specific). */
  settings?: Record<string, string>;
}

export interface ProvisionApplyResult {
  piFilesWritten: string[];
  piFilesBackedUp: string[];
  settingsApplied: string[];
  settingsSkipped: string[];
}

export interface ProvisionPushResult {
  target: string;
  sent: { piFiles: string[]; settings: string[] };
  applied: ProvisionApplyResult;
}
