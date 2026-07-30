import { afterEach, describe, expect, it, vi } from 'vitest'
import { installChunkLoadRecovery, isChunkLoadError } from './chunk-recovery'

function createRouterHooks() {
  let onErrorHandler: ((error: unknown) => void) | null = null
  let afterEachHandler: (() => void) | null = null
  return {
    router: {
      onError(handler: (error: unknown) => void) { onErrorHandler = handler },
      afterEach(handler: () => void) { afterEachHandler = handler },
    },
    raise(error: unknown) { onErrorHandler?.(error) },
    succeed() { afterEachHandler?.() },
  }
}

function createStorage() {
  const values = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
  }
}

describe('route chunk recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('recognizes browser dynamic import failures', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/page-old.js'))).toBe(true)
    expect(isChunkLoadError(new Error('ordinary navigation guard failure'))).toBe(false)
  })

  it('reloads once for a stale chunk and clears the marker after successful navigation', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const hooks = createRouterHooks()
    const storage = createStorage()
    const location = { href: 'https://example.test/users/create', reload: vi.fn() }
    installChunkLoadRecovery(hooks.router as never, location as never, storage)

    hooks.raise(new TypeError('Failed to fetch dynamically imported module'))
    expect(location.reload).toHaveBeenCalledTimes(1)

    hooks.raise(new TypeError('Failed to fetch dynamically imported module'))
    expect(location.reload).toHaveBeenCalledTimes(1)

    hooks.succeed()
    expect(storage.removeItem).toHaveBeenCalled()
  })

  it('does not reload for unrelated router errors', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const hooks = createRouterHooks()
    const storage = createStorage()
    const location = { href: 'https://example.test/users/create', reload: vi.fn() }
    installChunkLoadRecovery(hooks.router as never, location as never, storage)

    hooks.raise(new Error('guard rejected'))
    expect(location.reload).not.toHaveBeenCalled()
  })
})
