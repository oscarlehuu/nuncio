import type { DatabaseService } from '../../db/database.service';

export const CREW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS crew_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  preset_id TEXT NOT NULL CHECK (preset_id = 'quality'),
  definition_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crew_tasks (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  project_path TEXT NOT NULL,
  base_branch TEXT,
  base_head TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crew_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  prior_run_id TEXT,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  blocked_reason TEXT,
  profile_snapshot_json TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  context_revision INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  project_path TEXT NOT NULL,
  base_branch TEXT,
  worktree_path TEXT,
  branch TEXT,
  workspace_head TEXT,
  verify_retries_used INTEGER NOT NULL DEFAULT 0,
  review_retries_used INTEGER NOT NULL DEFAULT 0,
  verify_extra_rounds INTEGER NOT NULL DEFAULT 0,
  review_extra_rounds INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(task_id) REFERENCES crew_tasks(id),
  FOREIGN KEY(prior_run_id) REFERENCES crew_runs(id)
);

CREATE TABLE IF NOT EXISTS crew_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  context_revision INTEGER NOT NULL,
  workspace_head TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, seq),
  UNIQUE(run_id, idempotency_key),
  FOREIGN KEY(run_id) REFERENCES crew_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_crew_events_run_seq ON crew_events(run_id, seq);

CREATE TABLE IF NOT EXISTS crew_member_sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  member_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  session_id TEXT,
  prior_member_session_id TEXT,
  is_current INTEGER NOT NULL DEFAULT 1,
  lifecycle TEXT NOT NULL,
  context_health TEXT NOT NULL,
  last_seen_context_revision INTEGER NOT NULL DEFAULT 0,
  last_seen_workspace_head TEXT,
  last_used_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES crew_runs(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_members_current
ON crew_member_sessions(run_id, member_key) WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS crew_member_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  member_session_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  based_on_context_revision INTEGER NOT NULL,
  workspace_head TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, member_session_id, phase, attempt),
  FOREIGN KEY(run_id) REFERENCES crew_runs(id)
);

CREATE TABLE IF NOT EXISTS crew_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  relative_storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_count INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  retention_state TEXT NOT NULL DEFAULT 'retained',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES crew_runs(id)
);

CREATE TABLE IF NOT EXISTS crew_writer_leases (
  run_id TEXT PRIMARY KEY,
  member_session_id TEXT NOT NULL,
  task_id TEXT,
  token TEXT NOT NULL UNIQUE,
  starting_head TEXT,
  acquired_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES crew_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_crew_runs_task_created ON crew_runs(task_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_runs_one_active_per_task
ON crew_runs(task_id) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_crew_runs_status_project ON crew_runs(status, project_path);
CREATE INDEX IF NOT EXISTS idx_crew_members_run ON crew_member_sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_crew_results_run ON crew_member_results(run_id);
CREATE INDEX IF NOT EXISTS idx_crew_artifacts_run ON crew_artifacts(run_id);
`;

export function ensureCrewSchema(database: Pick<DatabaseService, 'db'>): void {
  database.db.exec(CREW_SCHEMA_SQL);
  const columns = database.db.prepare<{ name: string }, []>('PRAGMA table_info(crew_runs)').all();
  if (!columns.some((column) => column.name === 'base_head')) {
    database.db.exec('ALTER TABLE crew_runs ADD COLUMN base_head TEXT');
  }
}
