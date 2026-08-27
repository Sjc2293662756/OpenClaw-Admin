import { describe, expect, it, vi } from 'vitest'
import { destroyActiveNotification, destroyAllActiveNotifications, forgetActiveNotification } from './notification-lifecycle'

describe('active alert notification lifecycle', () => {
  it('forgets a notification after its leave transition without destroying a replacement entry', () => {
    const active = new Map([[7, { destroy: vi.fn() }]])
    forgetActiveNotification(active, 7)
    expect(active.size).toBe(0)
  })

  it('destroys a clicked notification and removes it before routing away', () => {
    const destroy = vi.fn()
    const active = new Map([[7, { destroy }]])
    destroyActiveNotification(active, 7)
    expect(destroy).toHaveBeenCalledOnce()
    expect(active.size).toBe(0)
  })

  it('destroys every retained notification when an account session ends', () => {
    const first = vi.fn()
    const second = vi.fn()
    const active = new Map([[7, { destroy: first }], [8, { destroy: second }]])
    destroyAllActiveNotifications(active)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(active.size).toBe(0)
  })
})
