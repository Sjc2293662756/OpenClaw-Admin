import { mapGAIOPAlertEvent, readGAIOPAlertReceiverUrl } from './gaiop-alert-source.js'
import {
  persistAlertStreamBaseline,
  persistAlertStreamRebaseline,
  persistAlertStreamStatus,
  persistProcessedAlertCursor,
  readAlertStreamState,
} from './alert-stream-state.js'

const ALERT_SCHEMA_VERSION = 'gaiop.alert-event.v1'
const ALERT_EVENT_TYPE = 'alert.created'
const ALERT_SEVERITIES = new Set(['轻微', '重大', '紧急'])
const DEFAULT_RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000]
const AUTH_RETRY_DELAY = 30_000
const MAX_SEEN_ALERT_IDS = 5_000

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseCursor(value, { allowZero = false } = {}) {
  const raw = String(value ?? '').trim()
  if (!/^\d+$/.test(raw)) return null
  const cursor = Number(raw)
  if (!Number.isSafeInteger(cursor) || cursor < (allowZero ? 0 : 1)) return null
  return cursor
}

function createSseParser({ onComment, onEvent }) {
  let buffer = ''
  let eventName = ''
  let eventId = ''
  let dataLines = []

  function dispatch() {
    if (dataLines.length > 0) {
      onEvent({ id: eventId, event: eventName || 'message', data: dataLines.join('\n') })
    }
    eventName = ''
    eventId = ''
    dataLines = []
  }

  function processLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) {
      dispatch()
      return
    }
    if (line.startsWith(':')) {
      onComment(line.slice(1).replace(/^ /, ''))
      return
    }
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (field === 'event') eventName = value
    else if (field === 'id' && !value.includes('\0')) eventId = value
    else if (field === 'data') dataLines.push(value)
  }

  return {
    feed(chunk) {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        processLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    },
  }
}

function readErrorPayload(response) {
  return response.json().catch(() => null)
}

function controlEvent(state, details = {}) {
  return {
    type: 'alertStreamState',
    state,
    ...details,
  }
}

export class AlertReceiverStreamClient {
  constructor({
    db,
    env = process.env,
    fetchImpl = fetch,
    broadcastAlert,
    broadcastState,
    logger = console,
    retryDelays = DEFAULT_RETRY_DELAYS,
    authRetryDelay = AUTH_RETRY_DELAY,
    connectTimeoutMs = 10_000,
  } = {}) {
    if (!db) throw new TypeError('alert_stream_database_required')
    if (typeof broadcastAlert !== 'function') throw new TypeError('alert_stream_broadcast_required')
    this.db = db
    this.env = { ...env }
    this.fetchImpl = fetchImpl
    this.broadcastAlert = broadcastAlert
    this.broadcastState = typeof broadcastState === 'function' ? broadcastState : () => true
    this.logger = logger
    this.retryDelays = retryDelays.length > 0 ? retryDelays.map((value) => Math.max(0, Number(value) || 0)) : [30_000]
    this.authRetryDelay = Math.max(0, Number(authRetryDelay) || AUTH_RETRY_DELAY)
    this.connectTimeoutMs = Math.max(100, Number(connectTimeoutMs) || 10_000)
    this.started = false
    this.loopPromise = null
    this.activeController = null
    this.retryTimer = null
    this.retryResolve = null
    this.retryAttempt = 0
    this.lastControlSignature = ''
    this.seenAlertIds = new Set()
  }

  configure(env) {
    const next = { ...env }
    const changed = next.GAIOP_ALERT_RECEIVER_URL !== this.env.GAIOP_ALERT_RECEIVER_URL
      || next.GAIOP_ALERT_RECEIVER_TOKEN !== this.env.GAIOP_ALERT_RECEIVER_TOKEN
      || next.NODE_ENV !== this.env.NODE_ENV
    this.env = next
    if (changed && this.started) {
      this.retryAttempt = 0
      this.activeController?.abort()
      this._wakeRetry()
    }
  }

  start() {
    if (this.started) return this.loopPromise
    this.started = true
    this.loopPromise = this._runLoop()
    return this.loopPromise
  }

  async stop() {
    if (!this.started && !this.loopPromise) return
    this.started = false
    this.activeController?.abort()
    this._wakeRetry()
    try {
      await this.loopPromise
    } catch {
      // The managed loop reports non-sensitive state and must not escape shutdown.
    }
    this.loopPromise = null
    persistAlertStreamStatus(this.db, { state: 'idle' })
  }

  getBrowserStateEvent() {
    const state = readAlertStreamState(this.db)
    const publicState = {
      authentication_error: 'authenticationError',
      receiver_reset: 'receiverReset',
      protocol_error: 'protocolError',
    }[state.connectionState] || state.connectionState
    return controlEvent(publicState, {
      gapState: state.gapState || undefined,
      oldestAvailableSequence: state.gapState ? state.oldestAvailableSequence : undefined,
      latestSequence: state.gapState ? state.latestSequence : undefined,
      historyRefreshRequired: Boolean(state.gapState),
    })
  }

  async runOnce() {
    if (this.activeController) throw new Error('alert_stream_connection_already_active')
    let endpoint
    try {
      const baseUrl = readGAIOPAlertReceiverUrl(this.env)
      if (baseUrl.username || baseUrl.password) throw new Error('credentials_in_url')
      endpoint = new URL('/events', baseUrl)
    } catch {
      this._setStatus('authentication_error', 'ALERT_RECEIVER_NOT_CONFIGURED', controlEvent('authenticationError'))
      return { reason: 'configuration_error', retryDelay: this.authRetryDelay }
    }

    const persisted = readAlertStreamState(this.db)
    const requestedCursor = persisted.resumeCursor
    const controller = new AbortController()
    this.activeController = controller
    persistAlertStreamStatus(this.db, { state: 'connecting' })
    const timeout = setTimeout(() => controller.abort(), this.connectTimeoutMs)
    timeout.unref?.()

    let response
    try {
      const headers = { Accept: 'text/event-stream' }
      const token = String(this.env.GAIOP_ALERT_RECEIVER_TOKEN || '')
      if (token) headers['X-GAIOP-Alert-Token'] = token
      if (requestedCursor !== null) headers['Last-Event-ID'] = String(requestedCursor)
      response = await this.fetchImpl(endpoint, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: controller.signal,
      })
      clearTimeout(timeout)
    } catch {
      clearTimeout(timeout)
      if (this.activeController === controller) this.activeController = null
      if (controller.signal.aborted && !this.started && this.loopPromise) return { reason: 'stopped', retryDelay: 0 }
      this._setStatus('unavailable', 'ALERT_RECEIVER_UNAVAILABLE', controlEvent('unavailable'))
      return { reason: 'network_error', retryDelay: this._retryDelay() }
    }

    try {
      if (response.status === 401) {
        await readErrorPayload(response)
        this._setStatus('authentication_error', 'ALERT_RECEIVER_UNAUTHORIZED', controlEvent('authenticationError'))
        return { reason: 'unauthorized', retryDelay: this.authRetryDelay }
      }
      if (response.status === 409) return await this._handleConflict(response)
      if (!response.ok || !response.body) {
        this._setStatus('unavailable', 'ALERT_RECEIVER_UNAVAILABLE', controlEvent('unavailable'))
        return { reason: 'receiver_error', retryDelay: this._retryDelay() }
      }

      const contentType = String(response.headers.get('content-type') || '').toLowerCase()
      if (!contentType.startsWith('text/event-stream')) {
        this._setStatus('protocol_error', 'ALERT_STREAM_CONTENT_TYPE_INVALID', controlEvent('protocolError'))
        return { reason: 'protocol_error', retryDelay: this._retryDelay() }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let baselineConfirmed = false
      let processingFailed = false
      const parser = createSseParser({
        onComment: (comment) => {
          const match = /^connected cursor=(\d+)$/.exec(comment)
          if (!match) return
          const baseline = parseCursor(match[1], { allowZero: true })
          if (baseline === null || (requestedCursor !== null && baseline !== requestedCursor)) {
            processingFailed = true
            this._setStatus('protocol_error', 'ALERT_STREAM_BASELINE_INVALID', controlEvent('protocolError'))
            return
          }
          if (requestedCursor === null) persistAlertStreamBaseline(this.db, baseline)
          else persistAlertStreamStatus(this.db, { state: 'connected', errorCode: null })
          baselineConfirmed = true
          this.retryAttempt = 0
          this._emitControl(controlEvent('connected'))
        },
        onEvent: (frame) => {
          if (processingFailed) return
          if (!baselineConfirmed) {
            processingFailed = true
            this._setStatus('protocol_error', 'ALERT_STREAM_BASELINE_MISSING', controlEvent('protocolError'))
            return
          }
          const outcome = this._processEvent(frame)
          if (outcome === 'failed') processingFailed = true
        },
      })

      while (!controller.signal.aborted && !processingFailed) {
        const { value, done } = await reader.read()
        if (done) break
        parser.feed(decoder.decode(value, { stream: true }))
      }
      if (processingFailed) {
        await reader.cancel().catch(() => {})
        controller.abort()
        return { reason: 'processing_failed', retryDelay: this._retryDelay() }
      }
      if (controller.signal.aborted && !this.started && this.loopPromise) return { reason: 'stopped', retryDelay: 0 }
      return { reason: 'eof', retryDelay: this._retryDelay() }
    } catch {
      if (controller.signal.aborted && !this.started && this.loopPromise) return { reason: 'stopped', retryDelay: 0 }
      this._setStatus('unavailable', 'ALERT_STREAM_READ_FAILED', controlEvent('unavailable'))
      return { reason: 'read_error', retryDelay: this._retryDelay() }
    } finally {
      clearTimeout(timeout)
      if (this.activeController === controller) this.activeController = null
    }
  }

  async _runLoop() {
    while (this.started) {
      let outcome
      try {
        outcome = await this.runOnce()
      } catch {
        this._setStatus('unavailable', 'ALERT_STREAM_INTERNAL_ERROR', controlEvent('unavailable'))
        outcome = { retryDelay: this._retryDelay() }
      }
      if (!this.started) break
      await this._wait(outcome.retryDelay)
    }
  }

  _processEvent(frame) {
    if (frame.event !== ALERT_EVENT_TYPE) {
      this._diagnostic('event_type_ignored')
      return 'ignored'
    }
    const idCursor = parseCursor(frame.id)
    if (idCursor === null) {
      this._diagnostic('event_id_invalid')
      return 'ignored'
    }
    let envelope
    try {
      envelope = JSON.parse(frame.data)
    } catch {
      this._diagnostic('event_json_invalid')
      return 'ignored'
    }
    if (!isRecord(envelope)
      || envelope.schemaVersion !== ALERT_SCHEMA_VERSION
      || envelope.eventType !== ALERT_EVENT_TYPE
      || !isRecord(envelope.alert)) {
      this._diagnostic('event_contract_ignored')
      return 'ignored'
    }
    const cursor = parseCursor(envelope.cursor)
    if (cursor === null || cursor !== idCursor) {
      this._diagnostic('event_cursor_invalid')
      return 'ignored'
    }
    const current = readAlertStreamState(this.db).resumeCursor
    if (current !== null && cursor <= current) {
      this._diagnostic('event_cursor_duplicate')
      return 'ignored'
    }
    if (!ALERT_SEVERITIES.has(envelope.alert.severity)) {
      this._diagnostic('event_severity_ignored')
      return 'ignored'
    }
    const alertId = String(envelope.alert.id || '').trim()
    if (!alertId || this.seenAlertIds.has(alertId)) {
      this._diagnostic(alertId ? 'event_alert_duplicate' : 'event_alert_id_invalid')
      return 'ignored'
    }

    const payload = mapGAIOPAlertEvent(envelope.alert)
    const event = {
      type: 'alert',
      action: payload.restored ? 'recovered' : 'triggered',
      cursor,
      payload,
    }
    try {
      if (this.broadcastAlert(event) === false) throw new Error('broadcast_rejected')
    } catch {
      this._diagnostic('event_broadcast_failed')
      return 'failed'
    }
    try {
      if (!persistProcessedAlertCursor(this.db, cursor)) {
        this._diagnostic('event_cursor_persist_failed')
        return 'failed'
      }
    } catch {
      this._diagnostic('event_cursor_persist_failed')
      return 'failed'
    }
    this.seenAlertIds.add(alertId)
    if (this.seenAlertIds.size > MAX_SEEN_ALERT_IDS) {
      this.seenAlertIds.delete(this.seenAlertIds.values().next().value)
    }
    return 'processed'
  }

  async _handleConflict(response) {
    const payload = await readErrorPayload(response)
    const code = String(payload?.code || '')
    const latestSequence = parseCursor(payload?.latestSequence, { allowZero: true })
    const oldestAvailableSequence = payload?.oldestAvailableSequence === null
      ? null
      : parseCursor(payload?.oldestAvailableSequence)
    if (!['ALERT_CURSOR_EXPIRED', 'ALERT_CURSOR_AHEAD'].includes(code) || latestSequence === null) {
      this._setStatus('protocol_error', 'ALERT_CURSOR_CONFLICT_INVALID', controlEvent('protocolError'))
      return { reason: 'conflict_invalid', retryDelay: this._retryDelay() }
    }
    if (code === 'ALERT_CURSOR_EXPIRED') {
      persistAlertStreamRebaseline(this.db, {
        state: 'gap',
        latestSequence,
        oldestAvailableSequence,
        errorCode: code,
      })
      this._emitControl(controlEvent('gap', {
        code,
        oldestAvailableSequence,
        latestSequence,
        historyRefreshRequired: true,
      }))
      this.retryAttempt = 0
      return { reason: 'cursor_expired', retryDelay: 0 }
    }
    persistAlertStreamRebaseline(this.db, {
      state: 'receiver_reset',
      latestSequence,
      oldestAvailableSequence,
      errorCode: code,
    })
    this._emitControl(controlEvent('receiverReset', {
      code,
      latestSequence,
      historyRefreshRequired: true,
    }))
    this.retryAttempt = 0
    return { reason: 'cursor_ahead', retryDelay: 0 }
  }

  _setStatus(state, errorCode, event) {
    persistAlertStreamStatus(this.db, { state, errorCode })
    this._emitControl(event)
  }

  _emitControl(event) {
    const signature = JSON.stringify(event)
    if (signature === this.lastControlSignature) return
    this.lastControlSignature = signature
    try {
      this.broadcastState(event)
    } catch {
      this._diagnostic('state_broadcast_failed')
    }
  }

  _diagnostic(code) {
    try {
      this.logger?.warn?.('[AlertStream] Event ignored', { code })
    } catch {
      // Diagnostics must never affect stream processing.
    }
  }

  _retryDelay() {
    const index = Math.min(this.retryAttempt, this.retryDelays.length - 1)
    const delay = this.retryDelays[index]
    this.retryAttempt += 1
    return delay
  }

  _wait(delay) {
    if (!this.started || delay <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      this.retryResolve = resolve
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        this.retryResolve = null
        resolve()
      }, delay)
      this.retryTimer.unref?.()
    })
  }

  _wakeRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const resolve = this.retryResolve
    this.retryResolve = null
    resolve?.()
  }
}

export const __test__ = {
  ALERT_EVENT_TYPE,
  ALERT_SCHEMA_VERSION,
  ALERT_SEVERITIES,
  createSseParser,
  parseCursor,
}
