import test from 'node:test'
import assert from 'node:assert/strict'
import { filterAlerts, parseSyslogAlerts } from './syslog-alerts.js'

test('does not treat an omitted time filter as the Unix epoch', () => {
  const alert = {
    occurredAt: '2026-07-16T01:00:00.000Z',
    category: 'appAlerts',
    severity: 'major',
    name: 'timeout',
    sourceHost: '10.0.0.8',
  }
  assert.equal(filterAlerts([alert], { startAt: null, endAt: null }).length, 1)
})

const sample = '2026-07-15T10:30:00+08:00 from=10.0.0.1 host=napm facility=local0 severity=notice tag=紧急: appAlerts severity=重大 name=接口超时 alertid=113 elogid=901 alertdesc="接口响应异常" condition="响应时间 > 10" metric1=响应时间 value1=15 units1=秒\n'

test('parses NAPM Syslog alerts without returning raw lines', () => {
  const { lines, alerts } = parseSyslogAlerts(Buffer.from(sample))
  assert.equal(lines, 1)
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].id, '901')
  assert.equal(alerts[0].categoryLabel, '应用性能告警')
  assert.equal(alerts[0].severity, '重大')
  assert.equal(alerts[0].metrics[0].value, '15')
  assert.equal(alerts[0].triggerCondition, '响应时间 > 10')
  assert.equal('rawBody' in alerts[0], false)
})

test('filters parsed alerts by supported list fields', () => {
  const { alerts } = parseSyslogAlerts(Buffer.from(sample))
  assert.equal(filterAlerts(alerts, { severity: '重大', keyword: '10.0.0.1', startAt: Date.parse('2026-07-15T10:00:00+08:00') }).length, 1)
  assert.equal(filterAlerts(alerts, { keyword: '响应' }).length, 0)
  assert.equal(filterAlerts(alerts, { severity: '紧急' }).length, 0)
})
