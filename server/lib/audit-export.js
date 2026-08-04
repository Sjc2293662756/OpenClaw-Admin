import AdmZip from 'adm-zip'

const COLUMN_WIDTHS = [22, 12, 18, 24, 14, 16, 28, 42, 28, 14, 12, 30, 24, 22, 38, 20]
const EXPORT_LOCALES = new Set(['zh-CN', 'en-US'])
const LABELS = {
  'zh-CN': {
    headers: ['时间', '结果', '操作用户', '用户ID', '用户角色', '分类', '操作', '说明', '对象', '来源', 'REST方法', 'REST路径', 'RPC方法', '错误码', '请求编号', '来源地址'],
    sheetName: '审计信息', missing: '历史未记录',
    result: { success: '成功', failed: '失败', denied: '拒绝' },
    role: { basic: '基础用户', auditor: '审计用户', standard: '标准用户', admin: '管理员', system: '系统' },
    category: { authentication: '身份认证', authorization: '权限校验', resource_access: '资源访问', operation: '业务操作', system: '系统事件' },
    source: { auth: '登录认证', rest: 'REST接口', rpc: 'Gateway RPC', system: '系统' },
  },
  'en-US': {
    headers: ['Time', 'Result', 'User', 'User ID', 'Role', 'Category', 'Action', 'Detail', 'Target', 'Source', 'REST method', 'REST path', 'RPC method', 'Error code', 'Request ID', 'Source address'],
    sheetName: 'Audit Logs', missing: 'Not recorded',
    result: { success: 'Success', failed: 'Failed', denied: 'Denied' },
    role: { basic: 'Basic user', auditor: 'Audit user', standard: 'Standard user', admin: 'Administrator', system: 'System' },
    category: { authentication: 'Authentication', authorization: 'Authorization', resource_access: 'Resource access', operation: 'Business operation', system: 'System event' },
    source: { auth: 'Authentication', rest: 'REST API', rpc: 'Gateway RPC', system: 'System' },
  },
}

export function normalizeExportLocale(value) {
  return EXPORT_LOCALES.has(value) ? value : 'zh-CN'
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function columnName(index) {
  let value = index + 1
  let result = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}

function cell(column, row, value, style = 0) {
  const styleAttribute = style ? ` s="${style}"` : ''
  return `<c r="${columnName(column)}${row}" t="inlineStr"${styleAttribute}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
}

function rowXml(rowNumber, values, style = 0) {
  return `<row r="${rowNumber}">${values.map((value, index) => cell(index, rowNumber, value, style)).join('')}</row>`
}

function sanitizeText(value, maxLength = 2000) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, maxLength)
  return /^[=+\-@]/.test(text) ? `'${text}` : text
}

function displayValue(value, locale) {
  const text = String(value ?? '').trim()
  return text || LABELS[locale].missing
}

function formatTime(value, locale) {
  const date = new Date(Number(value))
  if (!Number.isFinite(date.getTime())) return LABELS[locale].missing
  const two = (item) => String(item).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

export function normalizeAuditExportRows(logs, locale = 'zh-CN') {
  const normalizedLocale = normalizeExportLocale(locale)
  const labels = LABELS[normalizedLocale]
  if (!Array.isArray(logs)) return []
  return logs.slice(0, 3000).map((log) => [
    formatTime(log?.createdAt, normalizedLocale),
    labels.result[log?.result] || displayValue(log?.result, normalizedLocale),
    displayValue(log?.username, normalizedLocale),
    displayValue(log?.actorUserId, normalizedLocale),
    labels.role[log?.role] || displayValue(log?.role, normalizedLocale),
    labels.category[log?.category] || displayValue(log?.category, normalizedLocale),
    displayValue(log?.action, normalizedLocale),
    displayValue(log?.detail, normalizedLocale),
    displayValue(log?.target, normalizedLocale),
    labels.source[log?.source] || displayValue(log?.source, normalizedLocale),
    displayValue(log?.restMethod, normalizedLocale),
    displayValue(log?.restPath, normalizedLocale),
    displayValue(log?.rpcMethod, normalizedLocale),
    displayValue(log?.errorCode, normalizedLocale),
    displayValue(log?.requestId, normalizedLocale),
    displayValue(log?.sourceAddress, normalizedLocale),
  ].map((value, index) => sanitizeText(value, index === 7 || index === 14 ? 2000 : 500)))
}

export function createAuditExportWorkbook(logs, locale = 'zh-CN') {
  const normalizedLocale = normalizeExportLocale(locale)
  const labels = LABELS[normalizedLocale]
  const zip = new AdmZip()
  const dataRows = normalizeAuditExportRows(logs, normalizedLocale)
  const sheetRows = [rowXml(1, labels.headers, 1), ...dataRows.map((row, index) => rowXml(index + 2, row))].join('')
  const lastRow = Math.max(dataRows.length + 1, 1)
  const widths = COLUMN_WIDTHS.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')

  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`))
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`))
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${labels.sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`))
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`))
  zip.addFile('xl/styles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF18A058"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`))
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${widths}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:P${lastRow}"/></worksheet>`))
  return zip.toBuffer()
}
