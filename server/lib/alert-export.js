import AdmZip from 'adm-zip'

const COLUMN_WIDTHS = [22, 14, 38, 22, 18, 14]

const EXPORT_LOCALES = new Set(['zh-CN', 'en-US'])
const LABELS = {
  'zh-CN': {
    headers: ['告警时间', '严重级别', '告警名称', '告警类型', '来源 IP', '状态'],
    sheetName: '告警通知',
    severity: { critical: '紧急', urgent: '紧急', major: '重大', minor: '轻微' },
    category: { appAlerts: '应用性能告警', infrastructure: '基础设施告警', network: '网络告警', security: '安全告警' },
    status: { active: '触发中', triggered: '触发中', restored: '已恢复', resolved: '已恢复' },
  },
  'en-US': {
    headers: ['Alert time', 'Severity', 'Alert name', 'Category', 'Source IP', 'Status'],
    sheetName: 'Alerts',
    severity: { critical: 'Critical', urgent: 'Critical', major: 'Major', minor: 'Minor', '紧急': 'Critical', '重大': 'Major', '轻微': 'Minor' },
    category: { appAlerts: 'Application performance', infrastructure: 'Infrastructure', network: 'Network', security: 'Security', '应用性能告警': 'Application performance' },
    status: { active: 'Triggered', triggered: 'Triggered', restored: 'Restored', resolved: 'Restored', '触发中': 'Triggered', '已恢复': 'Restored' },
  },
}

export function normalizeExportLocale(value) {
  return EXPORT_LOCALES.has(value) ? value : 'zh-CN'
}

function localizedValue(group, value, locale) {
  const text = String(value ?? '').trim()
  return LABELS[locale][group][text] || text
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
  const text = escapeXml(value)
  return `<c r="${columnName(column)}${row}" t="inlineStr"${styleAttribute}><is><t xml:space="preserve">${text}</t></is></c>`
}

function rowXml(rowNumber, values, style = 0) {
  return `<row r="${rowNumber}">${values.map((value, index) => cell(index, rowNumber, value, style)).join('')}</row>`
}

function sanitizeText(value, maxLength = 2000) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, maxLength)
}

export function normalizeAlertExportRows(rows, locale = 'zh-CN') {
  const normalizedLocale = normalizeExportLocale(locale)
  if (!Array.isArray(rows)) return []
  return rows.slice(0, 100).map((row) => [
    sanitizeText(row?.occurredAt, 80),
    sanitizeText(localizedValue('severity', row?.severity, normalizedLocale), 40),
    sanitizeText(row?.name),
    sanitizeText(localizedValue('category', row?.category, normalizedLocale), 120),
    sanitizeText(row?.sourceHost, 120),
    sanitizeText(localizedValue('status', row?.status, normalizedLocale), 40),
  ])
}

export function createAlertExportWorkbook(rows, locale = 'zh-CN') {
  const normalizedLocale = normalizeExportLocale(locale)
  const labels = LABELS[normalizedLocale]
  const zip = new AdmZip()
  const dataRows = normalizeAlertExportRows(rows, normalizedLocale)
  const sheetRows = [rowXml(1, labels.headers, 1), ...dataRows.map((row, index) => rowXml(index + 2, row))].join('')
  const lastRow = Math.max(dataRows.length + 1, 1)
  const widths = COLUMN_WIDTHS.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')

  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`))
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`))
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${labels.sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`))
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`))
  zip.addFile('xl/styles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF18A058"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`))
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${widths}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:F${lastRow}"/></worksheet>`))
  return zip.toBuffer()
}
