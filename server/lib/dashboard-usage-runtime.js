function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function sessionKey(value) {
  const row = asRecord(value)
  return String(row.key || row.sessionKey || row.id || '').trim()
}

export function projectDashboardUsage(payload) {
  const row = asRecord(payload)
  const aggregates = asRecord(row.aggregates)
  const sessions = Array.isArray(row.sessions) ? row.sessions : []

  return {
    updatedAt: row.updatedAt,
    startDate: row.startDate,
    endDate: row.endDate,
    sessions: sessions
      .map((item) => {
        const source = asRecord(item)
        const usage = asRecord(source.usage)
        const key = sessionKey(source)
        if (!key) return null
        return {
          key,
          usage: Object.keys(usage).length > 0
            ? { totalTokens: Number(usage.totalTokens || usage.tokens || usage.total || 0) }
            : null,
        }
      })
      .filter(Boolean),
    totals: asRecord(row.totals),
    aggregates: {
      messages: asRecord(aggregates.messages),
      tools: asRecord(aggregates.tools),
      byModel: Array.isArray(aggregates.byModel) ? aggregates.byModel : [],
      byProvider: Array.isArray(aggregates.byProvider) ? aggregates.byProvider : [],
      byAgent: [],
      byChannel: [],
      daily: Array.isArray(aggregates.daily) ? aggregates.daily : [],
    },
  }
}

export function createDashboardUsageRuntime({
  loadUsage,
  ttlMs = 30_000,
  maxEntries = 64,
  now = () => Date.now(),
}) {
  const cache = new Map()
  const inFlight = new Map()

  function cacheKey({ principal, startDate, endDate }) {
    return `${principal}\u0000${startDate}\u0000${endDate}`
  }

  function pruneCache() {
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) return
      cache.delete(oldestKey)
    }
  }

  async function read(params) {
    const key = cacheKey(params)
    const cached = cache.get(key)
    if (!params.force && cached && cached.expiresAt > now()) {
      cache.delete(key)
      cache.set(key, cached)
      return { usage: cached.usage, cache: 'hit' }
    }

    const shared = inFlight.get(key)
    if (shared) {
      return { usage: await shared, cache: 'shared' }
    }

    const request = Promise.resolve()
      .then(() => loadUsage({
        startDate: params.startDate,
        endDate: params.endDate,
        limit: 1000,
      }))
      .then(projectDashboardUsage)
      .then((usage) => {
        cache.delete(key)
        cache.set(key, { usage, expiresAt: now() + ttlMs })
        pruneCache()
        return usage
      })
      .finally(() => {
        inFlight.delete(key)
      })

    inFlight.set(key, request)
    return { usage: await request, cache: 'miss' }
  }

  return {
    read,
    clear() {
      cache.clear()
    },
  }
}
