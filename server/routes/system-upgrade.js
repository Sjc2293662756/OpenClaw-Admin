import { Router } from 'express'
import { randomUUID } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'fs'
import { basename, extname, resolve } from 'path'
import multer from 'multer'
import { sendError, sendOk } from '../lib/api-response.js'
import { deleteUpgradeBackup, executeUpgradeTask, readSystemUpgradeOverview, readUpgradeTask, rollbackUpgradeBackup, validateUpgradePackage } from '../lib/system-upgrade-runtime.js'

const ADMIN_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const OWNED_UPLOAD_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.zip$/i
export const uploadStagingDir = resolve(process.env.GAIOP_ADMIN_UPGRADE_UPLOAD_STAGING_DIR || resolve(process.cwd(), 'data', 'upgrade-upload-staging'))
const packageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdirSync(uploadStagingDir, { recursive: true, mode: 0o700 })
      cb(null, uploadStagingDir)
    },
    filename: (_req, _file, cb) => cb(null, randomUUID() + '.zip'),
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const isZip = extname(file.originalname || '').toLowerCase() === '.zip'
    cb(isZip ? null : new Error('仅支持 ZIP 格式升级包'), isZip)
  },
})

function cleanupUpload(file) {
  try {
    if (file?.path) rmSync(file.path, { force: true })
  } catch {
    // Cleanup must not replace the original validation response.
  }
}

function addCleanupReason(result, outcome, reason) {
  result[outcome] += 1
  result.reasons[reason] = (result.reasons[reason] || 0) + 1
}

function recordCleanupCandidate(result, candidate) {
  result.candidateCount += 1
  result.candidateBytes += Number.isFinite(candidate.stat.size) ? Math.max(0, candidate.stat.size) : 0
  const timestamp = new Date(candidate.stat.mtimeMs).toISOString()
  if (!result.earliestCandidateTime || timestamp < result.earliestCandidateTime) result.earliestCandidateTime = timestamp
  if (!result.latestCandidateTime || timestamp > result.latestCandidateTime) result.latestCandidateTime = timestamp
}

function attachCleanupPlan(result, candidates) {
  Object.defineProperty(result, '_candidatePlan', { value: candidates, enumerable: false, configurable: true, writable: true })
  return result
}

function revalidateUploadCandidate(candidate, options, io) {
  const root = resolve(String(options.stagingDirectory || ''))
  const cutoffMs = Number(options.now) - Number(options.retentionMs)
  if (basename(root) !== 'upgrade-upload-staging' || candidate.target === root || !candidate.target.startsWith(`${root}/`) && !candidate.target.startsWith(`${root}\\`)) return false
  try {
    const current = io.lstatSync(candidate.target)
    return current.isFile() && !current.isSymbolicLink() && current.dev === candidate.stat.dev && current.ino === candidate.stat.ino && Number.isFinite(current.mtimeMs) && current.mtimeMs < cutoffMs && OWNED_UPLOAD_PATTERN.test(basename(candidate.target))
  } catch {
    return false
  }
}

export function discoverExpiredUpgradeUploadStaging({
  stagingDirectory = uploadStagingDir,
  now = Date.now(),
  retentionMs = ADMIN_UPLOAD_RETENTION_MS,
  fs = {},
} = {}) {
  const nowMs = Number(now)
  const cutoffMs = nowMs - retentionMs
  const result = {
    category: 'admin_upgrade_upload_staging',
    cutoffTime: Number.isFinite(cutoffMs) ? new Date(cutoffMs).toISOString() : null,
    success: 0,
    skipped: 0,
    failed: 0,
    freedBytes: 0,
    candidateCount: 0,
    candidateBytes: 0,
    earliestCandidateTime: null,
    latestCandidateTime: null,
    reasons: {},
  }
  const io = {
    existsSync: fs.existsSync || existsSync,
    lstatSync: fs.lstatSync || lstatSync,
    readdirSync: fs.readdirSync || readdirSync,
  }
  if (!Number.isFinite(nowMs) || !Number.isFinite(retentionMs) || retentionMs < 0) {
    addCleanupReason(result, 'failed', 'invalid_policy')
    return { result: attachCleanupPlan(result, []), candidates: [] }
  }

  const root = resolve(String(stagingDirectory || ''))
  if (basename(root) !== 'upgrade-upload-staging') {
    addCleanupReason(result, 'failed', 'unexpected_root_name')
    return { result: attachCleanupPlan(result, []), candidates: [] }
  }
  if (!stagingDirectory || !io.existsSync(root)) return { result: attachCleanupPlan(result, []), candidates: [] }
  let rootStat
  try {
    rootStat = io.lstatSync(root)
  } catch {
    addCleanupReason(result, 'failed', 'root_stat_failed')
    return { result: attachCleanupPlan(result, []), candidates: [] }
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    addCleanupReason(result, 'failed', 'unsafe_root')
    return { result: attachCleanupPlan(result, []), candidates: [] }
  }

  let entries
  try {
    entries = io.readdirSync(root, { withFileTypes: true })
  } catch {
    addCleanupReason(result, 'failed', 'root_read_failed')
    return { result: attachCleanupPlan(result, []), candidates: [] }
  }
  const candidates = []
  for (const entry of entries) {
    const target = resolve(root, entry.name)
    if (target === root || !target.startsWith(root + '\\') && !target.startsWith(root + '/')) {
      addCleanupReason(result, 'skipped', 'path_outside_root')
      continue
    }
    let stat
    try {
      stat = io.lstatSync(target)
    } catch {
      addCleanupReason(result, 'failed', 'entry_stat_failed')
      continue
    }
    if (stat.isSymbolicLink()) {
      addCleanupReason(result, 'skipped', 'symbolic_link')
      continue
    }
    if (!stat.isFile()) {
      addCleanupReason(result, 'skipped', entry.isDirectory() ? 'unknown_directory' : 'unknown_file_type')
      continue
    }
    if (!OWNED_UPLOAD_PATTERN.test(entry.name)) {
      addCleanupReason(result, 'skipped', 'unknown_filename')
      continue
    }
    if (!Number.isFinite(stat.mtimeMs) || stat.mtimeMs <= 0 || stat.mtimeMs > nowMs + MAX_CLOCK_SKEW_MS) {
      addCleanupReason(result, 'skipped', 'invalid_timestamp')
      continue
    }
    if (stat.mtimeMs >= cutoffMs) {
      addCleanupReason(result, 'skipped', 'not_expired')
      continue
    }
    const candidate = { target, stat }
    candidates.push(candidate)
    recordCleanupCandidate(result, candidate)
  }

  return { result: attachCleanupPlan(result, candidates), candidates }
}

export function cleanupExpiredUpgradeUploadStaging({
  stagingDirectory = uploadStagingDir,
  now = Date.now(),
  retentionMs = ADMIN_UPLOAD_RETENTION_MS,
  maxItems = 100,
  fs = {},
  dryRun = false,
  plan,
} = {}) {
  const io = {
    existsSync: fs.existsSync || existsSync,
    lstatSync: fs.lstatSync || lstatSync,
    readdirSync: fs.readdirSync || readdirSync,
    unlinkSync: fs.unlinkSync || unlinkSync,
  }
  const discovered = plan ? { result: plan.result, candidates: plan.candidates || [] } : discoverExpiredUpgradeUploadStaging({ stagingDirectory, now, retentionMs, fs })
  const result = discovered.result
  const candidates = [...discovered.candidates].sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs || left.target.localeCompare(right.target))
  const limit = Math.max(0, Math.floor(Number(maxItems) || 0))
  if (!dryRun) {
    for (const candidate of candidates.slice(0, limit)) {
      if (!revalidateUploadCandidate(candidate, { stagingDirectory, now, retentionMs }, io)) {
        addCleanupReason(result, 'skipped', 'entry_changed')
        continue
      }
      try {
        io.unlinkSync(candidate.target)
        result.success += 1
        result.freedBytes += Number.isFinite(candidate.stat.size) ? candidate.stat.size : 0
      } catch {
        addCleanupReason(result, 'failed', 'delete_failed')
      }
    }
  }
  for (let index = limit; index < candidates.length; index += 1) addCleanupReason(result, 'skipped', 'batch_limit')
  attachCleanupPlan(result, candidates)
  return result
}

function toPublicValidation(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors.slice(0, 20).map((item) => ({
    field: String(item?.field || '').slice(0, 100),
    message: String(item?.message || '校验失败').slice(0, 500),
  })) : []
  return {
    valid: payload?.valid === true,
    taskId: typeof payload?.task_id === 'string' ? payload.task_id : null,
    type: typeof payload?.type === 'string' ? payload.type : null,
    component: typeof payload?.component === 'string' ? payload.component : null,
    currentVersion: typeof payload?.current_version === 'string' ? payload.current_version : null,
    newVersion: typeof payload?.new_version === 'string' ? payload.new_version : null,
    displayName: typeof payload?.display_name === 'string' ? payload.display_name : null,
    changelog: typeof payload?.changelog === 'string' ? payload.changelog.slice(0, 10_000) : null,
    warnings: Array.isArray(payload?.warnings) ? payload.warnings.slice(0, 20) : [],
    errors,
    impact: payload?.impact && typeof payload.impact === 'object' ? {
      requiresRestart: payload.impact.requires_restart === true,
      requiresMaintenance: payload.impact.requires_maintenance === true,
      estimatedDowntimeSeconds: Number.isFinite(payload.impact.estimated_downtime_seconds) ? payload.impact.estimated_downtime_seconds : null,
    } : null,
  }
}

function toPublicTask(payload) {
  const allowedStepNames = new Set(['pre_check', 'backup', 'replace', 'reload', 'smoke_test', 'finalize'])
  const allowedStepStatuses = new Set(['waiting', 'running', 'completed', 'failed'])
  const allowedTaskStatuses = new Set(['pending', 'running', 'success', 'failed', 'rolling_back', 'rolled_back'])
  return {
    id: typeof payload?.id === 'string' ? payload.id : null,
    type: typeof payload?.type === 'string' ? payload.type : null,
    component: typeof payload?.component === 'string' ? payload.component : null,
    oldVersion: typeof payload?.old_version === 'string' ? payload.old_version : null,
    newVersion: typeof payload?.new_version === 'string' ? payload.new_version : null,
    status: allowedTaskStatuses.has(payload?.status) ? payload.status : 'unknown',
    progressPercent: Number.isFinite(payload?.progress_percent) ? Math.min(100, Math.max(0, payload.progress_percent)) : 0,
    currentStep: allowedStepNames.has(payload?.current_step) ? payload.current_step : null,
    estimatedRemainingSeconds: Number.isFinite(payload?.estimated_remaining_seconds) ? Math.max(0, payload.estimated_remaining_seconds) : null,
    error: typeof payload?.error === 'string' ? payload.error.slice(0, 500) : null,
    startedAt: typeof payload?.started_at === 'string' ? payload.started_at : null,
    finishedAt: typeof payload?.finished_at === 'string' ? payload.finished_at : null,
    steps: Array.isArray(payload?.steps) ? payload.steps
      .filter((step) => allowedStepNames.has(step?.step))
      .slice(0, 6)
      .map((step) => ({
        step: step.step,
        status: allowedStepStatuses.has(step.status) ? step.status : 'waiting',
        message: typeof step.message === 'string' ? step.message.slice(0, 500) : null,
      })) : [],
  }
}

function toPublicBackup(backup) {
  return {
    id: Number.isInteger(backup?.id) ? backup.id : null,
    component: typeof backup?.component === 'string' ? backup.component : null,
    version: typeof backup?.version === 'string' ? backup.version : null,
    sizeBytes: Number.isFinite(backup?.size_bytes) ? Math.max(0, backup.size_bytes) : 0,
    createdAt: typeof backup?.created_at === 'string' ? backup.created_at : null,
  }
}

function toPublicOverview(overview) {
  const sourceStatus = overview?.status && typeof overview.status === 'object' ? overview.status : null
  const component = (value) => value && typeof value === 'object' ? {
    version: typeof value.version === 'string' ? value.version : null,
    status: typeof value.status === 'string' ? value.status : null,
  } : null
  const skills = {}
  for (const [name, value] of Object.entries(sourceStatus?.skills || {})) {
    if (typeof name === 'string' && value && typeof value === 'object') skills[name] = component(value)
  }
  return {
    runtime: overview.runtime,
    status: sourceStatus ? {
      openclaw: component(sourceStatus.openclaw),
      frontend: component(sourceStatus.frontend),
      skills,
      maintenance_mode: sourceStatus.maintenance_mode === true,
    } : null,
    tasks: Array.isArray(overview.tasks) ? overview.tasks.slice(0, 10).map((task) => ({
      id: typeof task?.id === 'string' ? task.id : null,
      type: typeof task?.type === 'string' ? task.type : null,
      component: typeof task?.component === 'string' ? task.component : null,
      status: typeof task?.status === 'string' ? task.status : 'unknown',
      created_at: typeof task?.created_at === 'string' ? task.created_at : null,
    })) : [],
    backups: Array.isArray(overview.backups) ? overview.backups.slice(0, 50).map(toPublicBackup).filter((backup) => backup.id !== null) : [],
  }
}

function parseBackupId(value) {
  return /^[1-9]\d*$/.test(String(value || '')) ? Number(value) : null
}

export function createSystemUpgradeRouter({
  adminMiddleware,
  getUpgradeConfig,
  readOverview = readSystemUpgradeOverview,
  validatePackage = validateUpgradePackage,
  executeTask = executeUpgradeTask,
  readTask = readUpgradeTask,
  rollbackBackup = rollbackUpgradeBackup,
  deleteBackup = deleteUpgradeBackup,
  recordAudit = () => {},
}) {
  const router = Router()

  router.get('/overview', adminMiddleware, async (req, res) => {
    const config = getUpgradeConfig()
    const overview = await readOverview({
      serviceUrl: config.serviceUrl,
      internalToken: config.internalToken,
      actor: req.user?.username || 'admin',
    })
    sendOk(res, toPublicOverview(overview))
  })

  router.post('/validate', adminMiddleware, packageUpload.single('file'), async (req, res) => {
    if (!req.file) return sendError(res, { status: 400, code: 'UPGRADE_PACKAGE_REQUIRED', message: '请选择 ZIP 格式升级包' })
    try {
      const config = getUpgradeConfig()
      const result = await validatePackage({
        serviceUrl: config.serviceUrl,
        internalToken: config.internalToken,
        actor: req.user?.username || 'admin',
        filePath: req.file.path,
        fileName: req.file.originalname,
        force: req.body?.force === 'true',
      })
      if (result.state !== 'reachable') {
        return sendError(res, { status: 503, code: 'UPGRADE_SERVICE_UNAVAILABLE', message: '升级服务暂不可用或尚未部署' })
      }
      if (![200, 422].includes(result.status) || !result.payload) {
        return sendError(res, { status: 400, code: 'UPGRADE_PACKAGE_REJECTED', message: '升级包校验请求被拒绝' })
      }
      const validation = toPublicValidation(result.payload)
      recordAudit(req.user, '校验系统升级包', '系统升级', validation.valid ? ('校验通过，任务 ' + validation.taskId) : '校验未通过')
      sendOk(res, { validation })
    } finally {
      cleanupUpload(req.file)
    }
  })

  router.post('/tasks/:taskId/execute', adminMiddleware, async (req, res) => {
    const taskId = String(req.params.taskId || '')
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) {
      return sendError(res, { status: 400, code: 'UPGRADE_TASK_ID_INVALID', message: '升级任务标识无效' })
    }
    if (req.body?.confirmation !== 'EXECUTE') {
      return sendError(res, { status: 400, code: 'UPGRADE_EXECUTION_CONFIRMATION_REQUIRED', message: '请输入 EXECUTE 确认执行升级' })
    }
    const config = getUpgradeConfig()
    const result = await executeTask({
      serviceUrl: config.serviceUrl,
      internalToken: config.internalToken,
      actor: req.user?.username || 'admin',
      taskId,
    })
    if (result.state !== 'reachable') {
      return sendError(res, { status: 503, code: 'UPGRADE_SERVICE_UNAVAILABLE', message: '升级服务暂不可用或尚未部署' })
    }
    if (result.status !== 202) {
      return sendError(res, { status: result.status === 409 ? 409 : 400, code: 'UPGRADE_EXECUTION_REJECTED', message: '升级任务当前不能执行' })
    }
    recordAudit(req.user, '确认执行系统升级', '系统升级', '任务 ' + taskId)
    sendOk(res, { taskId, status: 'accepted' }, 202)
  })

  router.get('/tasks/:taskId', adminMiddleware, async (req, res) => {
    const taskId = String(req.params.taskId || '')
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) {
      return sendError(res, { status: 400, code: 'UPGRADE_TASK_ID_INVALID', message: '升级任务标识无效' })
    }
    const config = getUpgradeConfig()
    const result = await readTask({
      serviceUrl: config.serviceUrl,
      internalToken: config.internalToken,
      actor: req.user?.username || 'admin',
      taskId,
    })
    if (result.state !== 'reachable') {
      return sendError(res, { status: 503, code: 'UPGRADE_SERVICE_UNAVAILABLE', message: '升级服务暂不可用或尚未部署' })
    }
    if (result.status === 404) {
      return sendError(res, { status: 404, code: 'UPGRADE_TASK_NOT_FOUND', message: '升级任务不存在' })
    }
    if (result.status !== 200 || !result.payload) {
      return sendError(res, { status: 400, code: 'UPGRADE_TASK_READ_FAILED', message: '读取升级任务详情失败' })
    }
    sendOk(res, { task: toPublicTask(result.payload) })
  })

  router.post('/backups/:backupId/rollback', adminMiddleware, async (req, res) => {
    const backupId = parseBackupId(req.params.backupId)
    if (!backupId) return sendError(res, { status: 400, code: 'UPGRADE_BACKUP_ID_INVALID', message: '备份标识无效' })
    if (req.body?.confirmation !== 'ROLLBACK') {
      return sendError(res, { status: 400, code: 'UPGRADE_ROLLBACK_CONFIRMATION_REQUIRED', message: '请输入 ROLLBACK 确认回滚' })
    }
    const config = getUpgradeConfig()
    const overview = await readOverview({ serviceUrl: config.serviceUrl, internalToken: config.internalToken, actor: req.user?.username || 'admin' })
    if (overview.runtime?.state !== 'reachable') {
      return sendError(res, { status: 503, code: 'UPGRADE_SERVICE_UNAVAILABLE', message: '升级服务暂不可用或尚未部署' })
    }
    const backup = Array.isArray(overview.backups) ? overview.backups.find((item) => Number(item?.id) === backupId) : null
    if (!backup?.component || !backup?.version) {
      return sendError(res, { status: 404, code: 'UPGRADE_BACKUP_NOT_FOUND', message: '备份不存在或已被清理' })
    }
    const result = await rollbackBackup({
      serviceUrl: config.serviceUrl,
      internalToken: config.internalToken,
      actor: req.user?.username || 'admin',
      component: backup.component,
      targetVersion: backup.version,
    })
    if (result.state !== 'reachable') {
      return sendError(res, { status: 503, code: 'UPGRADE_SERVICE_UNAVAILABLE', message: '升级服务暂不可用或尚未部署' })
    }
    if (result.status !== 202 || typeof result.payload?.task_id !== 'string') {
      return sendError(res, { status: 400, code: 'UPGRADE_ROLLBACK_REJECTED', message: '当前备份不能执行回滚；目前仅支持 Skill 备份回滚' })
    }
    recordAudit(req.user, '确认回滚系统升级', '系统升级', '备份 ' + backupId + '，任务 ' + result.payload.task_id)
    sendOk(res, { taskId: result.payload.task_id, status: 'accepted' }, 202)
  })

  router.delete('/backups/:backupId', adminMiddleware, async (req, res) => {
    const backupId = parseBackupId(req.params.backupId)
    if (!backupId) return sendError(res, { status: 400, code: 'UPGRADE_BACKUP_ID_INVALID', message: '备份标识无效' })
    if (req.body?.confirmation !== 'DELETE') {
      return sendError(res, { status: 400, code: 'UPGRADE_BACKUP_DELETE_CONFIRMATION_REQUIRED', message: '请输入 DELETE 确认删除备份' })
    }
    const config = getUpgradeConfig()
    const result = await deleteBackup({
      serviceUrl: config.serviceUrl,
      internalToken: config.internalToken,
      actor: req.user?.username || 'admin',
      backupId,
    })
    if (result.state !== 'reachable') {
      return sendError(res, { status: 503, code: 'UPGRADE_SERVICE_UNAVAILABLE', message: '升级服务暂不可用或尚未部署' })
    }
    if (result.status === 404) {
      return sendError(res, { status: 404, code: 'UPGRADE_BACKUP_NOT_FOUND', message: '备份不存在或已被清理' })
    }
    if (result.status !== 200) {
      return sendError(res, { status: 400, code: 'UPGRADE_BACKUP_DELETE_REJECTED', message: '备份当前不能删除' })
    }
    recordAudit(req.user, '删除系统升级备份', '系统升级', '备份 ' + backupId)
    sendOk(res, { backupId, status: 'deleted' })
  })

  router.use((err, req, res, next) => {
    cleanupUpload(req.file)
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, { status: 413, code: 'UPGRADE_PACKAGE_TOO_LARGE', message: '升级包不能超过 500MB' })
    }
    if (err?.message === '仅支持 ZIP 格式升级包') {
      return sendError(res, { status: 400, code: 'UPGRADE_PACKAGE_FORMAT_INVALID', message: err.message })
    }
    next(err)
  })

  return router
}
