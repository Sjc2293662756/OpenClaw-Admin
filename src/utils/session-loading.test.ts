import { describe, expect, it, vi } from 'vitest'
import { loadSelectedSessionWithBackgroundList } from './session-loading'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('selected session startup', () => {
  it('starts route history first and does not wait for the session list', async () => {
    const events: string[] = []
    const history = deferred()
    const list = deferred()
    const loadHistory = vi.fn(() => {
      events.push('history')
      return history.promise
    })
    const refreshSessions = vi.fn(() => {
      events.push('list')
      return list.promise
    })

    const startup = loadSelectedSessionWithBackgroundList(
      'agent:main:main:dm:webchat-test',
      loadHistory,
      refreshSessions,
    )

    expect(events).toEqual(['history', 'list'])
    expect(loadHistory).toHaveBeenCalledWith('agent:main:main:dm:webchat-test')
    history.resolve()
    await startup
    expect(refreshSessions).toHaveBeenCalledTimes(1)

    list.resolve()
    await list.promise
  })
})
