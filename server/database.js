import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'
import { migrateUserSecurityColumns } from './lib/account-security.js'
import { migrateAuditLogColumns } from './lib/audit-service.js'
import { migratePersonalWechatMetadata } from './lib/personal-wechat-metadata.js'
import { migrateSessionRetentionTables } from './lib/session-retention-service.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const dataDir = process.env.GAIOP_ADMIN_DATA_DIR || join(__dirname, '../data')
mkdirSync(dataDir, { recursive: true })
const dbPath = join(dataDir, 'wizard.db')

const db = new Database(dbPath)

db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS scenarios (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'draft',
    agent_selection_mode TEXT DEFAULT 'existing',
    selected_agents TEXT DEFAULT '[]',
    generated_agents TEXT DEFAULT '[]',
    bindings TEXT DEFAULT '[]',
    tasks TEXT DEFAULT '[]',
    execution_log TEXT DEFAULT '[]',
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    scenario_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',
    assigned_agents TEXT DEFAULT '[]',
    priority TEXT DEFAULT 'medium',
    mode TEXT DEFAULT 'default',
    conversation_history TEXT DEFAULT '[]',
    execution_history TEXT DEFAULT '[]',
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS backup_records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    filename TEXT,
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    message TEXT,
    stage TEXT,
    error TEXT,
    result TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    completed_at INTEGER,
    size INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_scenario_id ON tasks(scenario_id);
  CREATE INDEX IF NOT EXISTS idx_scenarios_status ON scenarios(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_backup_records_created_at ON backup_records(created_at);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'basic' CHECK (role IN ('basic', 'auditor', 'standard', 'admin')),
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    is_initial_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_initial_admin IN (0, 1)),
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_updated_at ON users(updated_at DESC);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT,
    actor_username TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

  CREATE TABLE IF NOT EXISTS data_sources (
    id TEXT PRIMARY KEY,
    ip TEXT NOT NULL,
    description TEXT DEFAULT '',
    type TEXT NOT NULL CHECK (type IN ('local', 'remote')),
    username TEXT NOT NULL,
    password_encrypted TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('success', 'failed', 'untested', 'disabled')),
    tls_mode TEXT NOT NULL DEFAULT 'strict' CHECK (tls_mode IN ('strict', 'napm_self_signed')),
    is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    last_tested_at INTEGER,
    last_test_message TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_data_sources_updated_at ON data_sources(updated_at DESC);

  CREATE TABLE IF NOT EXISTS system_sensitive_configs (
    config_key TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN ('runtime', 'integration', 'security', 'certificate')),
    description TEXT DEFAULT '',
    is_sensitive INTEGER NOT NULL DEFAULT 1 CHECK (is_sensitive IN (0, 1)),
    value_plain TEXT,
    value_encrypted TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_system_sensitive_configs_category ON system_sensitive_configs(category, config_key);

  CREATE TABLE IF NOT EXISTS session_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    login_session_hours INTEGER NOT NULL DEFAULT 24,
    idle_timeout_minutes INTEGER NOT NULL DEFAULT 0,
    agent_context_idle_minutes INTEGER NOT NULL DEFAULT 30,
    history_retention_days INTEGER NOT NULL DEFAULT 180,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS branding_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    company_short_zh TEXT NOT NULL,
    company_legal_zh TEXT NOT NULL,
    company_english TEXT NOT NULL,
    company_brand_en TEXT NOT NULL,
    product_code TEXT NOT NULL,
    product_short_zh TEXT NOT NULL,
    product_full_zh TEXT NOT NULL,
    product_full_en TEXT NOT NULL,
    updated_by_user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspace_sessions (
    session_key TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    session_title TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_workspace_sessions_owner_active
    ON workspace_sessions(owner_user_id, status, updated_at DESC);

  -- Gateway intentionally protects its legacy default main session from
  -- destructive deletion.  Keep a local, auditable retirement marker instead
  -- of touching Gateway's private session store.
  CREATE TABLE IF NOT EXISTS hidden_legacy_sessions (
    session_key TEXT PRIMARY KEY,
    hidden_by_user_id TEXT NOT NULL,
    hidden_at INTEGER NOT NULL
  );

  -- Display-only titles for legacy WebChat sessions which predate BFF
  -- account ownership. They never grant access to a session.
  CREATE TABLE IF NOT EXISTS historical_webchat_titles (
    session_key TEXT PRIMARY KEY,
    session_title TEXT NOT NULL,
    title_source TEXT NOT NULL DEFAULT 'first_user_message',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS report_files (
    id TEXT PRIMARY KEY,
    stored_name TEXT NOT NULL UNIQUE,
    audit_name TEXT,
    original_name TEXT NOT NULL,
    report_type TEXT NOT NULL DEFAULT 'analysis',
    source_session_id TEXT,
    source_user_id TEXT,
    source_channel TEXT,
    source_channel_user_id TEXT,
    source_channel_user_name TEXT,
    source_message_id TEXT,
    source_message_preview TEXT,
    data_source_id TEXT,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'missing', 'failed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_report_files_created_at ON report_files(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_report_files_session_id ON report_files(source_session_id);

  CREATE TABLE IF NOT EXISTS report_deliveries (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL,
    event_name TEXT NOT NULL UNIQUE,
    channel TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('prepared', 'handed_off', 'confirmed', 'failed', 'expired')),
    prepared_at INTEGER,
    handed_off_at INTEGER,
    confirmed_at INTEGER,
    failed_at INTEGER,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_report_deliveries_report_id
    ON report_deliveries(report_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_report_deliveries_channel
    ON report_deliveries(channel, updated_at DESC);

  CREATE TABLE IF NOT EXISTS alert_ingestion_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    updated_at INTEGER NOT NULL
  );
`)

migrateUserSecurityColumns(db)
migrateAuditLogColumns(db)
migratePersonalWechatMetadata(db)
migrateSessionRetentionTables(db)

try {
  db.exec('ALTER TABLE scenarios ADD COLUMN execution_log TEXT DEFAULT \'[]\'')
} catch (e) {
  if (!e.message.includes('duplicate column name')) {
    console.error('[Database] Failed to add execution_log column:', e.message)
  }
}

try {
  db.exec('ALTER TABLE tasks ADD COLUMN execution_history TEXT DEFAULT \'[]\'')
} catch (e) {
  if (!e.message.includes('duplicate column name')) {
    console.error('[Database] Failed to add execution_history column:', e.message)
  }
}

try {
  db.exec('ALTER TABLE data_sources ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0')
} catch (e) {
  if (!e.message.includes('duplicate column name')) {
    console.error('[Database] Failed to add data_sources.is_active column:', e.message)
  }
}

try {
  db.exec("ALTER TABLE data_sources ADD COLUMN tls_mode TEXT NOT NULL DEFAULT 'strict'")
} catch (e) {
  if (!e.message.includes('duplicate column name')) {
    console.error('[Database] Failed to add data_sources.tls_mode column:', e.message)
  }
}

try {
  db.exec('ALTER TABLE report_files ADD COLUMN audit_name TEXT')
} catch (e) {
  if (!e.message.includes('duplicate column name')) {
    console.error('[Database] Failed to add report_files.audit_name column:', e.message)
  }
}

for (const column of [
  'source_channel TEXT',
  'source_channel_user_id TEXT',
  'source_channel_user_name TEXT',
  'source_message_id TEXT',
  'source_message_preview TEXT',
]) {
  try {
    db.exec(`ALTER TABLE report_files ADD COLUMN ${column}`)
  } catch (e) {
    if (!e.message.includes('duplicate column name')) {
      console.error(`[Database] Failed to add report_files.${column.split(' ')[0]} column:`, e.message)
    }
  }
}

db.exec('CREATE INDEX IF NOT EXISTS idx_report_files_source_channel ON report_files(source_channel, created_at DESC)')

try {
  db.exec('ALTER TABLE workspace_sessions ADD COLUMN session_title TEXT')
} catch (e) {
  if (!e.message.includes('duplicate column name')) {
    console.error('[Database] Failed to add workspace_sessions.session_title column:', e.message)
  }
}

try {
  db.exec('ALTER TABLE session_settings ADD COLUMN agent_context_idle_minutes INTEGER NOT NULL DEFAULT 30')
} catch (e) {
  if (!e.message.includes('duplicate column name')) {
    console.error('[Database] Failed to add session_settings.agent_context_idle_minutes column:', e.message)
  }
}

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_data_sources_single_active ON data_sources(is_active) WHERE is_active = 1')

export function createBackupRecord(id, type, filename = null) {
  const stmt = db.prepare(`
    INSERT INTO backup_records (id, type, filename, status, progress, message, created_at)
    VALUES (?, ?, ?, 'pending', 0, 'Task created', ?)
  `)
  stmt.run(id, type, filename, Date.now())
  return id
}

export function updateBackupRecord(id, updates) {
  const fields = []
  const values = []
  
  for (let [key, value] of Object.entries(updates)) {
    if (key === 'completedAt') key = 'completed_at'
    fields.push(`${key} = ?`)
    values.push(typeof value === 'object' ? JSON.stringify(value) : value)
  }
  
  values.push(id)
  
  const stmt = db.prepare(`UPDATE backup_records SET ${fields.join(', ')} WHERE id = ?`)
  stmt.run(...values)
}

export function getBackupRecord(id) {
  const stmt = db.prepare('SELECT * FROM backup_records WHERE id = ?')
  const record = stmt.get(id)
  if (record && record.result) {
    record.result = JSON.parse(record.result)
  }
  return record
}

export function getBackupRecords(limit = 20, offset = 0) {
  const stmt = db.prepare('SELECT * FROM backup_records ORDER BY created_at DESC LIMIT ? OFFSET ?')
  const records = stmt.all(limit, offset)
  return records.map(r => {
    if (r.result) {
      r.result = JSON.parse(r.result)
    }
    return r
  })
}

export function getBackupRecordsCount() {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM backup_records')
  return stmt.get().count
}

export function deleteBackupRecord(id) {
  const stmt = db.prepare('DELETE FROM backup_records WHERE id = ?')
  stmt.run(id)
}

console.log('[Database] Initialized at:', dbPath)

export default db
