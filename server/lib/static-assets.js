export function missingStaticAssetMiddleware(req, res, next) {
  const requestPath = String(req.path || '')
  if (requestPath !== '/assets' && !requestPath.startsWith('/assets/')) {
    next()
    return
  }

  res.set('Cache-Control', 'no-store')
  res.status(404).type('text/plain').send('Static asset not found')
}
