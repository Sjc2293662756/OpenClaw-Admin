import type { Router } from 'vue-router'

const RELOAD_MARKER = 'gaiop:chunk-reload'

type BrowserLocation = Pick<Location, 'href' | 'reload'>
type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function isChunkLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '')
  return [
    'Failed to fetch dynamically imported module',
    'Importing a module script failed',
    'error loading dynamically imported module',
    'Expected a JavaScript-or-Wasm module script',
  ].some(fragment => message.includes(fragment))
}

export function installChunkLoadRecovery(
  router: Pick<Router, 'onError' | 'afterEach'>,
  location: BrowserLocation = window.location,
  storage: BrowserStorage = window.sessionStorage,
) {
  router.onError((error) => {
    if (!isChunkLoadError(error)) {
      console.error('[Router] navigation failed:', error)
      return
    }

    try {
      if (storage.getItem(RELOAD_MARKER) === location.href) {
        storage.removeItem(RELOAD_MARKER)
        console.error('[Router] route chunk still unavailable after reload:', error)
        return
      }
      storage.setItem(RELOAD_MARKER, location.href)
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }

    location.reload()
  })

  router.afterEach(() => {
    try {
      storage.removeItem(RELOAD_MARKER)
    } catch {
      // A successful navigation needs no further recovery even without storage.
    }
  })
}
