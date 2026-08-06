/** 升级模块 TypeScript 类型定义 */

// ── /validate 响应 ──
export interface CompatibilityCheck {
  openclaw?: { current: string; required: string; ok: boolean }
  frontend?: { current: string; required: string; ok: boolean }
  napm_api?: { current: string; required: string; ok: boolean }
  dependencies?: Record<string, { current: string | null; required: string; ok: boolean }>
}

export interface Impact {
  requires_restart: boolean
  requires_maintenance: boolean
  affected_components: string[]
  estimated_downtime_seconds: number
}

export interface ValidationError {
  field: string
  message: string
}

export interface ValidateResult {
  task_id: string
  valid: boolean
  type?: string
  component?: string | null
  current_version?: string | null
  new_version?: string
  display_name?: string | null
  changelog?: string | null
  compatibility_check?: CompatibilityCheck
  impact?: Impact
  warnings?: string[]
  errors?: ValidationError[]
  task?: UpgradeTask
}

// ── 任务 ──
export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'rolling_back' | 'rolled_back'

export interface TaskStep {
  step: string
  status: 'waiting' | 'running' | 'completed' | 'failed'
  message: string
  started_at?: string | null
  finished_at?: string | null
}

export interface UpgradeTask {
  id: string
  type: string
  component: string | null
  old_version: string | null
  new_version: string | null
  status: TaskStatus
  steps: TaskStep[]
  started_at: string | null
  finished_at: string | null
  operator: string | null
  error: string | null
  created_at: string
  progress_percent?: number
  current_step?: string | null
  estimated_remaining_seconds?: number
}

export interface TaskListResult {
  tasks: UpgradeTask[]
  total: number
  limit: number
  offset: number
}

// ── /execute ──
export interface ExecuteResponse {
  task_id: string
  status: 'accepted'
  tracking_url: string
}

// ── /rollback ──
export interface RollbackRequest {
  component: string
  target_version?: string
  task_id?: string
}

// ── /status ──
export interface ComponentInfo {
  version: string
  status: string
}

export interface SystemStatus {
  openclaw: ComponentInfo | null
  frontend: ComponentInfo | null
  skills: Record<string, ComponentInfo>
  maintenance_mode: boolean
}

// ── /backups ──
export interface BackupRecord {
  id: number
  component: string
  version: string
  backup_path: string
  size_bytes: number
  created_at: string
}
