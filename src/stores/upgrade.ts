import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import type {
  ValidateResult,
  UpgradeTask,
  TaskListResult,
  ExecuteResponse,
  SystemStatus,
  BackupRecord,
} from '@/api/types/upgrade'

const API_BASE = '/api/v1/upgrade'

export const useUpgradeStore = defineStore('upgrade', () => {
  // ── 状态 ──
  const systemStatus = ref<SystemStatus | null>(null)
  const tasks = ref<UpgradeTask[]>([])
  const currentTask = ref<UpgradeTask | null>(null)
  const validateResult = ref<ValidateResult | null>(null)
  const backups = ref<BackupRecord[]>([])
  const loading = ref(false)
  const initializing = ref(false)

  // ── 计算属性 ──
  const hasActiveTask = computed(() =>
    tasks.value.some((t) => t.status === 'pending' || t.status === 'running' || t.status === 'rolling_back')
  )

  const activeTask = computed(() =>
    tasks.value.find((t) => t.status === 'running' || t.status === 'rolling_back') || null
  )

  // ── 工具 ──
  function getToken(): string {
    const authStore = useAuthStore()
    return authStore.token || localStorage.getItem('auth_token') || ''
  }

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${getToken()}` }
  }

  // ════════════════════════════════════════════════════════
  // GET /status
  // ════════════════════════════════════════════════════════
  async function fetchStatus(): Promise<SystemStatus> {
    const resp = await fetch(`${API_BASE}/status`, { headers: authHeaders() })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data: SystemStatus = await resp.json()
    systemStatus.value = data
    return data
  }

  // ════════════════════════════════════════════════════════
  // POST /validate
  // ════════════════════════════════════════════════════════
  async function validatePackage(file: File, force = false): Promise<ValidateResult> {
    loading.value = true
    try {
      const formData = new FormData()
      formData.append('file', file)
      if (force) formData.append('force', 'true')

      const resp = await fetch(`${API_BASE}/validate`, {
        method: 'POST',
        headers: authHeaders(),
        body: formData,
      })

      const data: ValidateResult = await resp.json()
      validateResult.value = data
      return data
    } finally {
      loading.value = false
    }
  }

  // ════════════════════════════════════════════════════════
  // POST /execute
  // ════════════════════════════════════════════════════════
  async function executeUpgrade(taskId: string): Promise<ExecuteResponse> {
    const resp = await fetch(`${API_BASE}/execute`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId }),
    })

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ message: `HTTP ${resp.status}` }))
      throw new Error(err.message || `HTTP ${resp.status}`)
    }

    const data: ExecuteResponse = await resp.json()
    // 开始轮询任务进度
    startPolling(taskId)
    return data
  }

  // ════════════════════════════════════════════════════════
  // GET /tasks
  // ════════════════════════════════════════════════════════
  async function fetchTasks(params?: {
    status?: string
    component?: string
    limit?: number
    offset?: number
  }): Promise<TaskListResult> {
    const query = new URLSearchParams()
    if (params?.status) query.set('status', params.status)
    if (params?.component) query.set('component', params.component)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))

    const url = `${API_BASE}/tasks${query.toString() ? '?' + query.toString() : ''}`
    const resp = await fetch(url, { headers: authHeaders() })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data: TaskListResult = await resp.json()
    tasks.value = data.tasks
    return data
  }

  // ════════════════════════════════════════════════════════
  // GET /tasks/:id
  // ════════════════════════════════════════════════════════
  async function fetchTask(taskId: string): Promise<UpgradeTask> {
    const resp = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`, {
      headers: authHeaders(),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data: UpgradeTask = await resp.json()
    currentTask.value = data
    return data
  }

  // ════════════════════════════════════════════════════════
  // POST /rollback
  // ════════════════════════════════════════════════════════
  async function rollback(component: string, targetVersion?: string): Promise<{ status: string; message?: string }> {
    const resp = await fetch(`${API_BASE}/rollback`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ component, target_version: targetVersion }),
    })

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ message: `HTTP ${resp.status}` }))
      throw new Error(err.message || `HTTP ${resp.status}`)
    }

    return resp.json()
  }

  // ════════════════════════════════════════════════════════
  // GET /backups
  // ════════════════════════════════════════════════════════
  async function fetchBackups(component?: string): Promise<BackupRecord[]> {
    const query = component ? `?component=${encodeURIComponent(component)}` : ''
    const resp = await fetch(`${API_BASE}/backups${query}`, { headers: authHeaders() })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    backups.value = data.backups || []
    return backups.value
  }

  // ════════════════════════════════════════════════════════
  // 轮询任务进度
  // ════════════════════════════════════════════════════════
  let _pollTimer: ReturnType<typeof setInterval> | null = null

  function startPolling(taskId: string) {
    stopPolling()
    _pollTimer = setInterval(async () => {
      try {
        const task = await fetchTask(taskId)
        // 更新任务列表中的对应条目
        const idx = tasks.value.findIndex((t) => t.id === taskId)
        if (idx >= 0) tasks.value[idx] = task
        else tasks.value.push(task)

        // 终态 → 停止轮询 + 刷新状态
        if (['success', 'failed', 'rolled_back'].includes(task.status)) {
          stopPolling()
          fetchStatus().catch(() => {})
        }
      } catch (_) { /* 轮询失败静默 */ }
    }, 2000)
  }

  function stopPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer)
      _pollTimer = null
    }
  }

  function clearValidateResult() {
    validateResult.value = null
  }

  // ════════════════════════════════════════════════════════
  // 初始化
  // ════════════════════════════════════════════════════════
  async function initialize(): Promise<void> {
    if (initializing.value) return
    initializing.value = true
    try {
      await Promise.all([fetchStatus(), fetchTasks({ limit: 20 })])
    } catch (e) {
      console.error('[UpgradeStore] Initialize failed:', e)
    } finally {
      initializing.value = false
    }
  }

  return {
    // state
    systemStatus,
    tasks,
    currentTask,
    validateResult,
    backups,
    loading,
    initializing,
    // computed
    hasActiveTask,
    activeTask,
    // actions
    initialize,
    fetchStatus,
    validatePackage,
    executeUpgrade,
    fetchTasks,
    fetchTask,
    rollback,
    fetchBackups,
    startPolling,
    stopPolling,
    clearValidateResult,
  }
})
