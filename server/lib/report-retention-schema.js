function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column)
}

function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/, 1)[0]
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

export function migrateReportRetention(db) {
  addColumn(db, 'report_files', 'long_term_keep INTEGER NOT NULL DEFAULT 0 CHECK (long_term_keep IN (0, 1))')
  addColumn(db, 'report_files', "retention_state TEXT NOT NULL DEFAULT 'active' CHECK (retention_state IN ('active', 'quarantine_pending', 'quarantined', 'quarantine_error', 'restore_error', 'delete_error'))")
  addColumn(db, 'report_files', 'quarantined_at INTEGER')
  addColumn(db, 'report_files', 'retention_error_code TEXT')
  addColumn(db, 'report_files', 'retention_updated_at INTEGER')

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_report_files_retention_candidates
      ON report_files(retention_state, long_term_keep, created_at, id);

    CREATE TABLE IF NOT EXISTS report_retention_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL,
      artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('report', 'audit', 'delivery')),
      artifact_key TEXT NOT NULL,
      source_name TEXT NOT NULL,
      recovery_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'moved', 'deleted')),
      moved_at INTEGER,
      deleted_at INTEGER,
      UNIQUE(report_id, artifact_kind, artifact_key)
    );

    CREATE INDEX IF NOT EXISTS idx_report_retention_artifacts_report
      ON report_retention_artifacts(report_id, id);

    CREATE TABLE IF NOT EXISTS report_retention_audits (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('quarantine', 'restore', 'permanent_delete', 'long_term_keep')),
      outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failed', 'skipped')),
      reason_code TEXT,
      artifact_count INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_report_retention_audits_created
      ON report_retention_audits(created_at DESC, id);
    CREATE INDEX IF NOT EXISTS idx_report_retention_audits_report
      ON report_retention_audits(report_id, created_at DESC);
  `)
}

export const __test__ = { hasColumn }
