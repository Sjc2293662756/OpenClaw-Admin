import { createReadStream, promises as fs } from 'fs'
import { extname, isAbsolute, relative, resolve, sep } from 'path'
import express from 'express'

const MAX_MEDIA_BYTES = 25 * 1024 * 1024
const CONTENT_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
])

function isContained(root, target) {
  const child = relative(root, target)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function normalizeRequestedPath(value) {
  if (typeof value !== 'string') return ''
  const candidate = value.trim().replaceAll('\\', '/')
  if (!candidate || candidate.length > 1024 || candidate.includes('\0')) return ''
  if (candidate.startsWith('/') || /^[a-zA-Z]:/.test(candidate)) return ''
  const segments = candidate.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return ''
  return segments.join(sep)
}

export function createMediaRouter({ authMiddleware, roots, authorizeSession }) {
  const router = express.Router()

  router.get('/', authMiddleware, async (req, res) => {
    const requestedPath = normalizeRequestedPath(req.query.path)
    const contentType = CONTENT_TYPES.get(extname(requestedPath).toLowerCase())
    if (!requestedPath || !contentType) {
      return res.status(400).json({ ok: false, code: 'INVALID_MEDIA_PATH', error: { message: '媒体路径无效' } })
    }

    const sessionKey = String(req.get('x-gaiop-session-key') || '').trim()
    if (req.user?.role !== 'admin') {
      const access = authorizeSession(req.user, sessionKey)
      if (!access?.ok) {
        return res.status(404).json({ ok: false, code: 'MEDIA_NOT_FOUND', error: { message: '媒体不存在或无权访问' } })
      }
    }

    for (const configuredRoot of roots()) {
      if (!configuredRoot) continue
      try {
        const root = await fs.realpath(resolve(configuredRoot))
        const candidate = resolve(root, requestedPath)
        if (!isContained(root, candidate)) continue
        const realCandidate = await fs.realpath(candidate)
        if (!isContained(root, realCandidate)) continue
        const stats = await fs.stat(realCandidate)
        if (!stats.isFile() || stats.size > MAX_MEDIA_BYTES) continue

        res.setHeader('Content-Type', contentType)
        res.setHeader('Content-Length', stats.size)
        res.setHeader('Cache-Control', 'private, no-store')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        const stream = createReadStream(realCandidate)
        stream.on('error', () => {
          if (!res.headersSent) res.status(500).json({ ok: false, code: 'MEDIA_READ_FAILED', error: { message: '媒体读取失败' } })
          else res.destroy()
        })
        stream.pipe(res)
        return
      } catch {
        // Try the next configured root without exposing filesystem details.
      }
    }

    return res.status(404).json({ ok: false, code: 'MEDIA_NOT_FOUND', error: { message: '媒体不存在或无权访问' } })
  })

  return router
}

export const __test__ = { normalizeRequestedPath, isContained, MAX_MEDIA_BYTES }
