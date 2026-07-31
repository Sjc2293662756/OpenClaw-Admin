function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function safeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function projectModelSelection(value, depth = 0) {
  if (depth > 4) return undefined
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => projectModelSelection(item, depth + 1))
      .filter((item) => item !== undefined)
  }
  const row = asRecord(value)
  const projected = {}
  for (const key of ['id', 'name', 'model', 'modelId', 'primary', 'fallback', 'models', 'modelIds', 'availableModels', 'whitelist']) {
    const next = projectModelSelection(row[key], depth + 1)
    if (next !== undefined) projected[key] = next
  }
  return Object.keys(projected).length ? projected : undefined
}

function unwrapConfig(value) {
  const row = asRecord(value)
  if (typeof row.raw === 'string') {
    try {
      return asRecord(JSON.parse(row.raw))
    } catch {
      return {}
    }
  }
  for (const key of ['config', 'data', 'value', 'payload', 'result']) {
    const candidate = asRecord(row[key])
    if (Object.keys(candidate).length) return unwrapConfig(candidate)
  }
  return row
}

export function projectStandardGatewayConfig(value) {
  const root = unwrapConfig(value)
  const models = asRecord(root.models)
  const providers = asRecord(models.providers)
  const projectedProviders = {}
  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = asRecord(providerValue)
    const projected = {}
    for (const key of ['models', 'modelIds', 'availableModels', 'whitelist']) {
      const next = projectModelSelection(provider[key])
      if (next !== undefined) projected[key] = next
    }
    if (Object.keys(projected).length) projectedProviders[providerId] = projected
  }

  const projectedModels = {}
  for (const key of ['primary', 'fallback', 'aliases']) {
    const next = projectModelSelection(models[key])
    if (next !== undefined) projectedModels[key] = next
  }
  if (Object.keys(projectedProviders).length) projectedModels.providers = projectedProviders

  const defaults = asRecord(asRecord(root.agents).defaults)
  const projectedDefaults = {}
  for (const key of ['model', 'models']) {
    const next = projectModelSelection(defaults[key])
    if (next !== undefined) projectedDefaults[key] = next
  }

  return {
    models: projectedModels,
    agents: { defaults: projectedDefaults },
  }
}

function extractList(value, candidates) {
  if (Array.isArray(value)) return value
  const row = asRecord(value)
  for (const key of candidates) {
    if (Array.isArray(row[key])) return row[key]
  }
  return []
}

export function projectSafeSkillsPayload(value) {
  return extractList(value, ['skills', 'items', 'list', 'data', 'entries']).map((item) => {
    const row = asRecord(item)
    return Object.fromEntries(Object.entries({
      name: safeString(row.name || row.id),
      description: safeString(row.description),
      version: safeString(row.version),
      source: safeString(row.source || row.origin || row.scope),
      eligible: typeof row.eligible === 'boolean' ? row.eligible : undefined,
      disabled: typeof row.disabled === 'boolean' ? row.disabled : undefined,
      installed: typeof row.installed === 'boolean' ? row.installed : undefined,
      available: typeof row.available === 'boolean' ? row.available : undefined,
      status: safeString(row.status),
    }).filter(([, itemValue]) => itemValue !== undefined))
  })
}

function channelStatus(row) {
  const explicit = safeString(row.status)
  if (explicit) return explicit
  if (row.connected === true || row.running === true || row.linked === true) return 'connected'
  return 'disconnected'
}

export function projectSafeChannelsPayload(value) {
  const direct = extractList(value, ['channels', 'items', 'list', 'data', 'status'])
  if (direct.length) {
    return direct.map((item) => {
      const row = asRecord(item)
      const channelKey = safeString(row.channelKey || row.platform || row.id || row.name)
      return {
        id: safeString(row.id) || channelKey,
        channelKey,
        platform: safeString(row.platform) || channelKey,
        enabled: row.enabled !== false,
        status: channelStatus(row),
      }
    })
  }

  const row = asRecord(value)
  const accountsByChannel = asRecord(row.channelAccounts)
  const summaries = asRecord(row.channels)
  const keys = new Set([...Object.keys(accountsByChannel), ...Object.keys(summaries)])
  return [...keys].map((channelKey) => {
    const summary = asRecord(summaries[channelKey])
    return {
      id: channelKey,
      channelKey,
      platform: channelKey,
      enabled: summary.enabled !== false,
      status: channelStatus(summary),
    }
  })
}

export function projectSafePluginsPayload(value) {
  return extractList(value, ['plugins', 'items', 'list', 'data', 'entries']).map((item) => {
    const row = asRecord(item)
    return Object.fromEntries(Object.entries({
      name: safeString(row.name || row.id || row.key),
      version: safeString(row.version),
      installed: typeof row.installed === 'boolean' ? row.installed : undefined,
      enabled: typeof row.enabled === 'boolean' ? row.enabled : undefined,
      status: safeString(row.status),
    }).filter(([, itemValue]) => itemValue !== undefined))
  })
}
