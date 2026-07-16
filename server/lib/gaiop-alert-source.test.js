import assert from 'node:assert/strict'
import test from 'node:test'
import { mapGAIOPAlertEvent, readGAIOPAlerts } from './gaiop-alert-source.js'

test('maps the formal receiver event to the established Admin alert read model', () => {
  const alert = mapGAIOPAlertEvent({
    id: 'event-1',
    eventId: 'event-1',
    occurredAt: 1_784_000_000_000,
    sourceIp: '10.0.0.8',
    category: 'appAlerts',
    severity: 'critical',
    name: 'timeout',
    ruleId: 113,
    metrics: [{ name: 'latency', value: 'N/D', unit: 'ms' }],
    status: 'recovered',
  })

  assert.equal(alert.sourceHost, '10.0.0.8')
  assert.equal(alert.category, 'appAlerts')
  assert.equal(alert.ruleId, 113)
  assert.equal(alert.restored, true)
  assert.equal('raw' in alert, false)
})

test('reads the formal receiver and restores the established chronological input order', async () => {
  const fetchCalls = []
  const result = await readGAIOPAlerts({ GAIOP_ALERT_RECEIVER_URL: 'http://127.0.0.1:19090' }, 3000, async (url) => {
    fetchCalls.push(String(url))
    return new Response(JSON.stringify({
      ok: true,
      availableCount: 2,
      hasMore: false,
      alerts: [
        { id: 'newer', occurredAt: 2_000, sourceIp: '10.0.0.2', category: 'appAlerts', severity: 'major', name: 'newer' },
        { id: 'older', occurredAt: 1_000, sourceIp: '10.0.0.1', category: 'appAlerts', severity: 'major', name: 'older' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })

  assert.match(fetchCalls[0], /pageSize=3000/)
  assert.deepEqual(result.alerts.map((alert) => alert.id), ['older', 'newer'])
  assert.equal(result.availableCount, 2)
})
