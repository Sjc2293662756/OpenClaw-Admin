import { existsSync, readFileSync } from 'fs'

export const REPORT_ATTRIBUTION_SCHEMA = 'gaiop.report-attribution.v1'

function safeText(value, maxLength = 512) {
  const text = String(value || '').trim()
  return text ? text.slice(0, maxLength) : null
}

function normalizeStoredName(value) {
  const name = safeText(value, 1024)?.replace(/\\/g, '/')
  if (!name || name.startsWith('/') || name.split('/').some((part) => !part || part === '.' || part === '..')) return null
  return name
}

export function readReportAttributionIndex(indexPath = process.env.GAIOP_REPORT_ATTRIBUTION_INDEX_PATH || '/var/lib/gaiop/report-attribution/index.json') {
  if (!existsSync(indexPath)) return new Map()
  try {
    const payload = JSON.parse(readFileSync(indexPath, 'utf8'))
    if (payload?.schemaVersion !== REPORT_ATTRIBUTION_SCHEMA || !Array.isArray(payload.entries)) return new Map()
    const entries = new Map()
    for (const value of payload.entries) {
      const storedName = normalizeStoredName(value?.storedName)
      const auditName = normalizeStoredName(value?.auditName)
      const reportId = safeText(value?.reportId, 512)
      const sourceSessionId = safeText(value?.sourceSessionId, 1024)
      const sourceUserId = safeText(value?.sourceUserId, 512)
      const sourceChannel = safeText(value?.sourceChannel, 128)?.toLowerCase()
      if (!storedName || !auditName || !reportId || !sourceSessionId || !sourceUserId || !sourceChannel) continue
      entries.set(storedName, {
        storedName,
        auditName,
        reportId,
        sourceSessionId,
        sourceUserId,
        sourceChannel,
        sourceChannelUserId: safeText(value?.sourceChannelUserId, 512),
        sourceChannelUserName: safeText(value?.sourceChannelUserName, 512),
        dataSourceId: safeText(value?.dataSourceId, 512),
        evidence: safeText(value?.evidence, 128),
      })
    }
    return entries
  } catch {
    return new Map()
  }
}

export function resolveReportAttribution(entries, { storedName, auditName, reportId }) {
  const entry = entries.get(String(storedName || '').replace(/\\/g, '/'))
  if (!entry) return null
  if (entry.auditName !== String(auditName || '').replace(/\\/g, '/')) return null
  if (entry.reportId !== String(reportId || '').trim()) return null
  return entry
}

export function resolveReportAttributionByAudit(entries, { auditName, reportId }) {
  const expectedAuditName = String(auditName || '').replace(/\\/g, '/')
  const expectedReportId = String(reportId || '').trim()
  let match = null
  for (const entry of entries.values()) {
    if (entry.auditName !== expectedAuditName || entry.reportId !== expectedReportId) continue
    if (match) return null
    match = entry
  }
  return match
}
