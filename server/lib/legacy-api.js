export const RETIRED_API_PREFIXES = Object.freeze([
  '/api/agents/workspace',
  '/api/hermes-cli',
  '/api/hermes',
  '/api/files',
  '/api/config',
  '/api/npm',
  '/api/backup',
  '/api/terminal',
  '/api/desktop',
])

export function createRetiredApiMiddleware(prefix) {
  return (_req, res) => res.status(410).json({
    ok: false,
    code: 'ENDPOINT_RETIRED',
    error: { message: `接口已停用：${prefix}` },
  })
}

/**
 * Register before every product router and every retained legacy handler.
 * Express resolves middleware in registration order, so later source cannot
 * become reachable accidentally while it remains pending physical cleanup.
 */
export function registerRetiredApiBarriers(app) {
  for (const prefix of RETIRED_API_PREFIXES) {
    app.use(prefix, createRetiredApiMiddleware(prefix))
  }
}
