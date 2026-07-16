import { Router } from 'express'

export function createAuditRouter({ db, auditViewerMiddleware }) {
  const router = Router()

  router.get('/', auditViewerMiddleware, (req, res) => {
    const requestedLimit = Number.parseInt(String(req.query.limit || '100'), 10)
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100
    const logs = db.prepare(`SELECT id, actor_username, actor_role, action, target, detail, created_at
      FROM audit_logs ORDER BY created_at DESC LIMIT ?`).all(limit)
    res.json({ ok: true, logs: logs.map((log) => ({
      id: log.id,
      username: log.actor_username,
      role: log.actor_role,
      action: log.action,
      target: log.target || '',
      detail: log.detail || '',
      createdAt: log.created_at,
    })) })
  })

  return router
}
