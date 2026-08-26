import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { AlertReceiverStreamClient } from './alert-receiver-stream.js'
import { migrateAlertStreamState, readAlertStreamState } from './alert-stream-state.js'

function createDb() {
  const db = new Database(':memory:')
  migrateAlertStreamState(db)
  return db
}

function streamResponse(chunks, { status = 200, contentType = 'text/event-stream; charset=utf-8' } = {}) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status, headers: { 'content-type': contentType } })
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function rawAlert(cursor, severity = '重大', overrides = {}) {
  return {
    id: `alert-${cursor}`,
    eventId: `event-${cursor}`,
    occurredAt: 1_784_000_000_000 + cursor,
    sourceIp: '198.51.100.10',
    category: 'userAlerts',
    severity,
    name: `alert ${cursor}`,
    ruleId: '42',
    metrics: [],
    status: 'active',
    ...overrides,
  }
}

function eventFrame(cursor, severity = '重大', overrides = {}) {
  const alert = rawAlert(cursor, severity, overrides.alert)
  const envelope = {
    schemaVersion: 'gaiop.alert-event.v1',
    eventType: 'alert.created',
    cursor,
    alert,
    ...overrides.envelope,
  }
  return `id: ${overrides.id ?? cursor}\nevent: ${overrides.event ?? 'alert.created'}\ndata: ${overrides.data ?? JSON.stringify(envelope)}\n\n`
}

function createClient({ db = createDb(), responses = [], fetchImpl, broadcastAlert, broadcastState } = {}) {
  const calls = []
  const alerts = []
  const states = []
  const client = new AlertReceiverStreamClient({
    db,
    env: {
      NODE_ENV: 'production',
      GAIOP_ALERT_RECEIVER_URL: 'http://127.0.0.1:19090',
      GAIOP_ALERT_RECEIVER_TOKEN: 'internal-test-token',
    },
    fetchImpl: fetchImpl || (async (url, options) => {
      calls.push({ url: String(url), options })
      const response = responses.shift()
      if (response instanceof Error) throw response
      return response
    }),
    broadcastAlert: broadcastAlert || ((event) => { alerts.push(event); return true }),
    broadcastState: broadcastState || ((event) => { states.push(event); return true }),
    retryDelays: [0],
    authRetryDelay: 0,
    connectTimeoutMs: 1_000,
    logger: { warn() {} },
  })
  return { client, db, calls, alerts, states }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed_out_waiting_for_condition')
}

test('keeps one upstream connection and stops its active fetch on shutdown', async () => {
  let calls = 0
  let active = 0
  const context = createClient({
    fetchImpl: async (_url, options) => {
      calls += 1
      active += 1
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          active -= 1
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })
    },
  })

  const first = context.client.start()
  const second = context.client.start()
  assert.equal(first, second)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(active, 1)
  await context.client.stop()
  assert.equal(active, 0)
  assert.equal(readAlertStreamState(context.db).connectionState, 'idle')
})

test('persists a split initial connected cursor comment before any alert arrives', async () => {
  const context = createClient({ responses: [streamResponse([': connected cur', 'sor=17\r\n\r\n'])] })
  const outcome = await context.client.runOnce()

  assert.equal(outcome.reason, 'eof')
  assert.deepEqual(readAlertStreamState(context.db), {
    resumeCursor: 17,
    lastProcessedCursor: null,
    connectionState: 'connected',
    gapState: null,
    oldestAvailableSequence: null,
    latestSequence: null,
    lastErrorCode: null,
    gapDetectedAt: null,
    updatedAt: readAlertStreamState(context.db).updatedAt,
  })
  assert.equal(context.calls[0].options.headers.Accept, 'text/event-stream')
  assert.equal(context.calls[0].options.headers['X-GAIOP-Alert-Token'], 'internal-test-token')
  assert.equal('Last-Event-ID' in context.calls[0].options.headers, false)
  assert.equal(String(context.calls[0].url).includes('internal-test-token'), false)
})

test('projects and broadcasts all three severities using the established alert model', async () => {
  const chunks = [
    ': connected cursor=0\n\n',
    eventFrame(1, '轻微'),
    eventFrame(2, '重大'),
    eventFrame(3, '紧急', { alert: { status: 'recovered' } }),
  ]
  const context = createClient({ responses: [streamResponse(chunks)] })
  await context.client.runOnce()

  assert.deepEqual(context.alerts.map((event) => event.payload.severity), ['轻微', '重大', '紧急'])
  assert.deepEqual(context.alerts.map((event) => event.action), ['triggered', 'triggered', 'recovered'])
  assert.deepEqual(context.alerts[0], {
    type: 'alert',
    action: 'triggered',
    cursor: 1,
    payload: {
      id: 'alert-1',
      occurredAt: new Date(1_784_000_000_001).toISOString(),
      sourceHost: '198.51.100.10',
      category: 'userAlerts',
      categoryLabel: '用户体验告警',
      severity: '轻微',
      name: 'alert 1',
      ruleId: 42,
      metrics: [],
      description: null,
      triggerCondition: null,
      groupPath: null,
      startTime: null,
      endTime: null,
      eventId: 'event-1',
      restored: false,
    },
  })
  assert.equal(readAlertStreamState(context.db).lastProcessedCursor, 3)
})

test('ignores malformed, unknown, mismatched, unsupported and out-of-order events without advancing', async () => {
  const cases = [
    eventFrame(1, '重大', { data: '{bad-json' }),
    eventFrame(1, '重大', { event: 'alert.updated' }),
    eventFrame(1, '重大', { envelope: { schemaVersion: 'gaiop.alert-event.v2' } }),
    eventFrame(1, '一般'),
    eventFrame(1, '重大', { id: 2 }),
  ]
  for (const frame of cases) {
    const context = createClient({ responses: [streamResponse([': connected cursor=0\n\n', frame])] })
    await context.client.runOnce()
    assert.equal(context.alerts.length, 0)
    assert.equal(readAlertStreamState(context.db).resumeCursor, 0)
    context.db.close()
  }

  const db = createDb()
  const first = createClient({ db, responses: [streamResponse([': connected cursor=0\n\n', eventFrame(1)])] })
  await first.client.runOnce()
  const duplicate = createClient({ db, responses: [streamResponse([': connected cursor=1\n\n', eventFrame(1)])] })
  await duplicate.client.runOnce()
  assert.equal(duplicate.alerts.length, 0)
  assert.equal(readAlertStreamState(db).lastProcessedCursor, 1)
})

test('does not advance when browser broadcast fails and retries with the same cursor', async () => {
  const context = createClient({
    responses: [streamResponse([': connected cursor=0\n\n', eventFrame(1)])],
    broadcastAlert: () => false,
  })
  const outcome = await context.client.runOnce()
  assert.equal(outcome.reason, 'processing_failed')
  assert.equal(readAlertStreamState(context.db).resumeCursor, 0)
  assert.equal(readAlertStreamState(context.db).lastProcessedCursor, null)
})

test('reconnects from persisted cursor with Last-Event-ID and survives a BFF restart', async () => {
  const db = createDb()
  const first = createClient({ db, responses: [streamResponse([': connected cursor=2\n\n'])] })
  await first.client.runOnce()

  const restarted = createClient({ db, responses: [streamResponse([': connected cursor=2\n\n', eventFrame(3)])] })
  await restarted.client.runOnce()
  assert.equal(restarted.calls[0].options.headers['Last-Event-ID'], '2')
  assert.deepEqual(restarted.alerts.map((event) => event.cursor), [3])
  assert.equal(readAlertStreamState(db).lastProcessedCursor, 3)
})

test('automatically reconnects after EOF with Last-Event-ID and resumes delivery', async () => {
  const encoder = new TextEncoder()
  const calls = []
  let attempt = 0
  const context = createClient({
    fetchImpl: async (_url, options) => {
      calls.push(options)
      attempt += 1
      if (attempt === 1) return streamResponse([': connected cursor=5\n\n'])
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`: connected cursor=5\n\n${eventFrame(6)}`))
          options.signal.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })

  context.client.start()
  await waitFor(() => context.alerts.length === 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].headers['Last-Event-ID'], '5')
  assert.equal(context.alerts[0].cursor, 6)
  await context.client.stop()
})

test('records an unresolved expired gap, broadcasts safe bounds and rebaselines at latest', async () => {
  const db = createDb()
  const initial = createClient({ db, responses: [streamResponse([': connected cursor=4\n\n'])] })
  await initial.client.runOnce()
  const context = createClient({
    db,
    responses: [
      jsonResponse(409, {
        ok: false,
        code: 'ALERT_CURSOR_EXPIRED',
        oldestAvailableSequence: 10,
        latestSequence: 20,
      }),
      streamResponse([': connected cursor=20\n\n']),
    ],
  })

  assert.equal((await context.client.runOnce()).reason, 'cursor_expired')
  assert.deepEqual(context.states.at(-1), {
    type: 'alertStreamState',
    state: 'gap',
    code: 'ALERT_CURSOR_EXPIRED',
    gapState: 'unresolved',
    oldestAvailableSequence: 10,
    latestSequence: 20,
    historyRefreshRequired: true,
  })
  const gap = readAlertStreamState(db)
  assert.equal(gap.resumeCursor, 20)
  assert.equal(gap.lastProcessedCursor, null)
  assert.equal(gap.gapState, 'unresolved')

  await context.client.runOnce()
  assert.equal(context.calls[1].options.headers['Last-Event-ID'], '20')
  assert.deepEqual(context.states.at(-1), {
    type: 'alertStreamState',
    state: 'connected',
    gapState: 'unresolved',
    oldestAvailableSequence: 10,
    latestSequence: 20,
    historyRefreshRequired: true,
  })
  assert.deepEqual(context.client.getBrowserStateEvent(), context.states.at(-1))
})

test('records an ahead cursor as Receiver reset and safely rebuilds its baseline', async () => {
  const db = createDb()
  const initial = createClient({ db, responses: [streamResponse([': connected cursor=30\n\n'])] })
  await initial.client.runOnce()
  const context = createClient({
    db,
    responses: [
      jsonResponse(409, {
        ok: false,
        code: 'ALERT_CURSOR_AHEAD',
        oldestAvailableSequence: 1,
        latestSequence: 3,
      }),
      streamResponse([': connected cursor=3\n\n']),
    ],
  })
  assert.equal((await context.client.runOnce()).reason, 'cursor_ahead')
  const state = readAlertStreamState(db)
  assert.equal(state.resumeCursor, 3)
  assert.equal(state.gapState, 'receiver_reset')
  assert.deepEqual(context.states.at(-1), {
    type: 'alertStreamState',
    state: 'receiverReset',
    code: 'ALERT_CURSOR_AHEAD',
    gapState: 'receiver_reset',
    oldestAvailableSequence: 1,
    latestSequence: 3,
    historyRefreshRequired: true,
  })

  await context.client.runOnce()
  assert.equal(context.calls[1].options.headers['Last-Event-ID'], '3')
  assert.deepEqual(context.states.at(-1), {
    type: 'alertStreamState',
    state: 'connected',
    gapState: 'receiver_reset',
    oldestAvailableSequence: 1,
    latestSequence: 3,
    historyRefreshRequired: true,
  })
  assert.deepEqual(context.client.getBrowserStateEvent(), context.states.at(-1))
})

test('retains unresolved gap details while connection errors change the live stream state', async () => {
  const context = createClient({ responses: [
    jsonResponse(409, {
      ok: false,
      code: 'ALERT_CURSOR_EXPIRED',
      oldestAvailableSequence: 10,
      latestSequence: 20,
    }),
    jsonResponse(401, { ok: false, code: 'ALERT_RECEIVER_UNAUTHORIZED' }),
    new Error('network down'),
    streamResponse([], { contentType: 'application/json' }),
  ] })

  assert.equal((await context.client.runOnce()).reason, 'cursor_expired')
  assert.equal((await context.client.runOnce()).reason, 'unauthorized')
  assert.deepEqual(context.states.at(-1), {
    type: 'alertStreamState',
    state: 'authenticationError',
    code: 'ALERT_RECEIVER_UNAUTHORIZED',
    gapState: 'unresolved',
    oldestAvailableSequence: 10,
    latestSequence: 20,
    historyRefreshRequired: true,
  })

  assert.equal((await context.client.runOnce()).reason, 'network_error')
  assert.deepEqual(context.states.at(-1), {
    type: 'alertStreamState',
    state: 'unavailable',
    code: 'ALERT_RECEIVER_UNAVAILABLE',
    gapState: 'unresolved',
    oldestAvailableSequence: 10,
    latestSequence: 20,
    historyRefreshRequired: true,
  })

  assert.equal((await context.client.runOnce()).reason, 'protocol_error')
  assert.deepEqual(context.states.at(-1), {
    type: 'alertStreamState',
    state: 'protocolError',
    code: 'ALERT_STREAM_CONTENT_TYPE_INVALID',
    gapState: 'unresolved',
    oldestAvailableSequence: 10,
    latestSequence: 20,
    historyRefreshRequired: true,
  })
})

test('handles authentication and network failures without throwing or changing its resume cursor', async () => {
  const db = createDb()
  const initial = createClient({ db, responses: [streamResponse([': connected cursor=8\n\n'])] })
  await initial.client.runOnce()

  const unauthorized = createClient({
    db,
    responses: [jsonResponse(401, { ok: false, code: 'ALERT_RECEIVER_UNAUTHORIZED' })],
  })
  assert.equal((await unauthorized.client.runOnce()).reason, 'unauthorized')
  assert.equal(readAlertStreamState(db).resumeCursor, 8)
  assert.equal(readAlertStreamState(db).connectionState, 'authentication_error')

  const unavailable = createClient({ db, responses: [new Error('network down')] })
  assert.equal((await unavailable.client.runOnce()).reason, 'network_error')
  assert.equal(readAlertStreamState(db).resumeCursor, 8)
  assert.equal(readAlertStreamState(db).connectionState, 'unavailable')
})

test('idempotently consumes a duplicate business alert id and restarts from its newer cursor', async () => {
  const db = createDb()
  const context = createClient({ db, responses: [streamResponse([
    ': connected cursor=0\n\n',
    eventFrame(1, '重大', { alert: { id: 'same-alert' } }),
    eventFrame(2, '紧急', { alert: { id: 'same-alert' } }),
  ])] })
  await context.client.runOnce()
  assert.deepEqual(context.alerts.map((event) => event.cursor), [1])
  assert.equal(readAlertStreamState(db).resumeCursor, 2)
  assert.equal(readAlertStreamState(db).lastProcessedCursor, 2)

  const restarted = createClient({ db, responses: [streamResponse([
    ': connected cursor=2\n\n',
    eventFrame(3, '紧急', { alert: { id: 'same-alert' } }),
  ])] })
  await restarted.client.runOnce()
  assert.equal(restarted.calls[0].options.headers['Last-Event-ID'], '2')
  assert.deepEqual(restarted.alerts.map((event) => event.cursor), [3])
  assert.equal(readAlertStreamState(db).resumeCursor, 3)
})
