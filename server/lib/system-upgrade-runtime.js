import { randomBytes } from 'crypto'
import { createReadStream } from 'fs'
import { Readable } from 'stream'

const REQUEST_TIMEOUT_MS = 5_000
const PACKAGE_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000

function parseServiceUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

async function requestJson(baseUrl, path, { internalToken, actor }) {
  const url = new URL(path, baseUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(internalToken ? {
          'X-GAIOP-Upgrade-Token': internalToken,
          'X-GAIOP-Upgrade-Actor': actor,
        } : {}),
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      const error = new Error('UPGRADE_SERVICE_UNAVAILABLE')
      error.code = 'UPGRADE_SERVICE_UNAVAILABLE'
      throw error
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function serviceHeaders({ internalToken, actor }) {
  return {
    Accept: 'application/json',
    ...(internalToken ? {
      'X-GAIOP-Upgrade-Token': internalToken,
      'X-GAIOP-Upgrade-Actor': actor,
    } : {}),
  }
}

async function readResponse(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function requestService(baseUrl, path, { internalToken, actor, method = 'GET', body, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: { ...serviceHeaders({ internalToken, actor }), ...headers },
      body,
      ...(body ? { duplex: 'half' } : {}),
      signal: controller.signal,
    })
    return { status: response.status, payload: await readResponse(response) }
  } finally {
    clearTimeout(timer)
  }
}

function safeUploadName(value) {
  return String(value || 'upgrade.zip').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'upgrade.zip'
}

function createMultipartStream({ filePath, fileName, force }) {
  const boundary = '----GAIOPUpgrade' + randomBytes(16).toString('hex')
  const prefix = Buffer.from(
    '--' + boundary + '\r\n'
    + 'Content-Disposition: form-data; name="force"\r\n\r\n'
    + (force ? 'true' : 'false') + '\r\n'
    + '--' + boundary + '\r\n'
    + 'Content-Disposition: form-data; name="file"; filename="' + safeUploadName(fileName) + '"\r\n'
    + 'Content-Type: application/zip\r\n\r\n',
  )
  const suffix = Buffer.from('\r\n--' + boundary + '--\r\n')

  async function* body() {
    yield prefix
    for await (const chunk of createReadStream(filePath)) yield chunk
    yield suffix
  }

  return {
    body: Readable.from(body()),
    contentType: 'multipart/form-data; boundary=' + boundary,
  }
}

export async function validateUpgradePackage({ serviceUrl, internalToken, actor, filePath, fileName, force = false }) {
  const baseUrl = parseServiceUrl(serviceUrl)
  if (!baseUrl) return { state: 'not-configured', status: 503, payload: null }
  try {
    const multipart = createMultipartStream({ filePath, fileName, force })
    const result = await requestService(baseUrl, '/api/v1/upgrade/validate', {
      internalToken,
      actor,
      method: 'POST',
      body: multipart.body,
      headers: { 'Content-Type': multipart.contentType },
      timeoutMs: PACKAGE_REQUEST_TIMEOUT_MS,
    })
    return { state: 'reachable', ...result }
  } catch {
    return { state: 'unavailable', status: 503, payload: null }
  }
}

export async function executeUpgradeTask({ serviceUrl, internalToken, actor, taskId }) {
  const baseUrl = parseServiceUrl(serviceUrl)
  if (!baseUrl) return { state: 'not-configured', status: 503, payload: null }
  try {
    const result = await requestService(baseUrl, '/api/v1/upgrade/execute', {
      internalToken,
      actor,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, force: false }),
    })
    return { state: 'reachable', ...result }
  } catch {
    return { state: 'unavailable', status: 503, payload: null }
  }
}

export async function readUpgradeTask({ serviceUrl, internalToken, actor, taskId }) {
  const baseUrl = parseServiceUrl(serviceUrl)
  if (!baseUrl) return { state: 'not-configured', status: 503, payload: null }
  try {
    const result = await requestService(baseUrl, '/api/v1/upgrade/tasks/' + encodeURIComponent(taskId), {
      internalToken,
      actor,
    })
    return { state: 'reachable', ...result }
  } catch {
    return { state: 'unavailable', status: 503, payload: null }
  }
}

export async function rollbackUpgradeBackup({ serviceUrl, internalToken, actor, component, targetVersion }) {
  const baseUrl = parseServiceUrl(serviceUrl)
  if (!baseUrl) return { state: 'not-configured', status: 503, payload: null }
  try {
    const result = await requestService(baseUrl, '/api/v1/upgrade/rollback', {
      internalToken,
      actor,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ component, target_version: targetVersion }),
    })
    return { state: 'reachable', ...result }
  } catch {
    return { state: 'unavailable', status: 503, payload: null }
  }
}

export async function deleteUpgradeBackup({ serviceUrl, internalToken, actor, backupId }) {
  const baseUrl = parseServiceUrl(serviceUrl)
  if (!baseUrl) return { state: 'not-configured', status: 503, payload: null }
  try {
    const result = await requestService(baseUrl, '/api/v1/upgrade/backups/' + encodeURIComponent(backupId), {
      internalToken,
      actor,
      method: 'DELETE',
    })
    return { state: 'reachable', ...result }
  } catch {
    return { state: 'unavailable', status: 503, payload: null }
  }
}

export async function readSystemUpgradeOverview({ serviceUrl, internalToken, actor }) {
  const baseUrl = parseServiceUrl(serviceUrl)
  if (!baseUrl) {
    return {
      runtime: { state: 'not-configured', serviceVersion: null, lastErrorCode: null },
      status: null,
      tasks: [],
      backups: [],
    }
  }

  try {
    const [health, status, tasks, backups] = await Promise.all([
      requestJson(baseUrl, '/health', { internalToken, actor }),
      requestJson(baseUrl, '/api/v1/upgrade/status', { internalToken, actor }),
      requestJson(baseUrl, '/api/v1/upgrade/tasks?limit=10', { internalToken, actor }),
      requestJson(baseUrl, '/api/v1/upgrade/backups', { internalToken, actor }),
    ])
    return {
      runtime: {
        state: 'reachable',
        serviceVersion: typeof health.version === 'string' ? health.version : null,
        lastErrorCode: null,
      },
      status,
      tasks: Array.isArray(tasks.tasks) ? tasks.tasks : [],
      backups: Array.isArray(backups.backups) ? backups.backups : [],
    }
  } catch {
    return {
      runtime: { state: 'unavailable', serviceVersion: null, lastErrorCode: 'UPGRADE_SERVICE_UNAVAILABLE' },
      status: null,
      tasks: [],
      backups: [],
    }
  }
}
