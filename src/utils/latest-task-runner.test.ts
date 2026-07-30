import { describe, expect, it } from 'vitest'
import { createLatestTaskRunner } from './latest-task-runner'

describe('latest task runner', () => {
  it('serializes work and keeps only the latest pending value', async () => {
    const started: string[] = []
    const completed: string[] = []
    const releases: Array<() => void> = []
    const runner = createLatestTaskRunner<string>(async (value, intentId) => {
      started.push(value)
      await new Promise<void>((resolve) => releases.push(resolve))
      if (runner.isCurrent(intentId)) completed.push(value)
    })

    const first = runner.enqueue('7d')
    runner.enqueue('30d')
    const latest = runner.enqueue('90d')
    await Promise.resolve()
    expect(started).toEqual(['7d'])

    releases.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['7d', '90d'])
    expect(completed).toEqual([])

    releases.shift()?.()
    await latest.done
    expect(completed).toEqual(['90d'])
    expect(runner.isCurrent(first.intentId)).toBe(false)
    expect(runner.isCurrent(latest.intentId)).toBe(true)
  })
})
