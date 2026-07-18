import { Router } from 'express'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { extname, resolve } from 'path'
import multer from 'multer'
import { sendError, sendOk } from '../lib/api-response.js'
import { deleteUpgradeBackup, executeUpgradeTask, readSystemUpgradeOverview, readUpgradeTask, rollbackUpgradeBackup, validateUpgradePackage } from '../lib/system-upgrade-runtime.js'

const uploadStagingDir = resolve(process.cwd(), 'data', 'upgrade-upload-staging')
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
