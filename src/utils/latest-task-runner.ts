export function createLatestTaskRunner<T>(
  worker: (value: T, intentId: number) => Promise<void>
) {
  let latestIntentId = 0
  let pending: { value: T; intentId: number } | null = null
  let active: Promise<void> | null = null

  async function drain() {
    while (pending) {
      const request = pending
      pending = null
      await worker(request.value, request.intentId)
    }
  }

  function enqueue(value: T) {
    const intentId = ++latestIntentId
    pending = { value, intentId }
    if (!active) {
      active = drain().finally(() => {
        active = null
      })
    }
    return { intentId, done: active }
  }

  return {
    enqueue,
    isCurrent(intentId: number) {
      return intentId === latestIntentId
    },
  }
}
