import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import {
  ModulePermissionError,
  getModulePermissionCatalog,
  getUserModulePermissionProjection,
  replaceUserModulePermissionOverrides,
} from '../lib/module-permissions.js'

function handleError(res, error) {
  if (error instanceof ModulePermissionError) {
    return res.status(error.status).json({ ok: false, error: error.message, code: error.code, ...error.extra })
  }
  return sendError(res, { status: 500, code: 'MODULE_PERMISSION_OPERATION_FAILED', message: '模块权限操作失败' })
}

export function createModulePermissionsRouter({
  db,
  authMiddleware,
  initialAdminMiddleware,
  recordAudit,
  notifyPermissionsChanged,
}) {
  const catalogRouter = Router()
  catalogRouter.get('/', authMiddleware, (_req, res) => sendOk(res, { modules: getModulePermissionCatalog() }))

  const userRouter = Router({ mergeParams: true })
  userRouter.get('/', initialAdminMiddleware, (req, res) => {
    try {
      return sendOk(res, getUserModulePermissionProjection(db, req.params.id))
    } catch (error) {
      return handleError(res, error)
    }
  })
  userRouter.put('/', initialAdminMiddleware, (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new ModulePermissionError(400, 'INVALID_PERMISSION_PAYLOAD', '请求体格式无效')
      }
      const keys = Object.keys(req.body).sort()
      if (keys.length !== 2 || keys[0] !== 'expectedVersion' || keys[1] !== 'overrides') {
        throw new ModulePermissionError(400, 'INVALID_PERMISSION_PAYLOAD', '请求体只能包含 expectedVersion 和 overrides')
      }
      const projection = replaceUserModulePermissionOverrides(db, {
        actor: req.user,
        userId: req.params.id,
        expectedVersion: req.body.expectedVersion,
        overrides: req.body.overrides,
        recordAudit,
      })
      notifyPermissionsChanged?.(req.params.id, projection.permissionVersion)
      return sendOk(res, projection)
    } catch (error) {
      return handleError(res, error)
    }
  })
  userRouter.delete('/', initialAdminMiddleware, (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'expectedVersion')) {
        throw new ModulePermissionError(400, 'INVALID_PERMISSION_PAYLOAD', '请求体只能包含 expectedVersion')
      }
      const projection = replaceUserModulePermissionOverrides(db, {
        actor: req.user,
        userId: req.params.id,
        expectedVersion: req.body.expectedVersion,
        overrides: [],
        recordAudit,
        action: '恢复用户模块默认权限',
      })
      notifyPermissionsChanged?.(req.params.id, projection.permissionVersion)
      return sendOk(res, projection)
    } catch (error) {
      return handleError(res, error)
    }
  })

  return { catalogRouter, userRouter }
}
