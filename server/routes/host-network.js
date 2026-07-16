import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'

function parseStringList(value, fieldName, maxItems = 32) {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string' || item.trim().length === 0 || item.trim().length > 255)) {
    throw new Error(`${fieldName}格式不正确`)
  }
  return value.map(item => item.trim())
}

function isIpv4(value) {
  const parts = String(value || '').trim().split('.')
  return parts.length === 4 && parts.every(part => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
}

function publicHostNetworkConfig(row) {
  return {
    hostname: row?.hostname || '',
    domain: row?.domain || '',
    ipAddress: row?.ip_address || '',
    subnetMask: row?.subnet_mask || '',
    gateway: row?.gateway || '',
    dnsServers: row?.dns_servers ? JSON.parse(row.dns_servers) : [],
    internalAddressRanges: row?.internal_address_ranges ? JSON.parse(row.internal_address_ranges) : [],
    timezone: row?.timezone || 'Asia/Shanghai',
    ntpServers: row?.ntp_servers ? JSON.parse(row.ntp_servers) : [],
    locale: row?.locale || 'zh-CN',
    updatedAt: row?.updated_at || null,
  }
}

export function createHostNetworkRouter({ db, authMiddleware, adminMiddleware, recordAudit }) {
  const router = Router()

  router.get('/', authMiddleware, (_req, res) => {
    const row = db.prepare('SELECT * FROM host_network_config WHERE id = 1').get()
    sendOk(res, { config: publicHostNetworkConfig(row) })
  })

  router.put('/', adminMiddleware, (req, res) => {
    try {
      const hostname = String(req.body?.hostname || '').trim()
      const domain = String(req.body?.domain || '').trim()
      const ipAddress = String(req.body?.ipAddress || '').trim()
      const subnetMask = String(req.body?.subnetMask || '').trim()
      const gateway = String(req.body?.gateway || '').trim()
      const timezone = String(req.body?.timezone || '').trim()
      const locale = String(req.body?.locale || '').trim()
      if (!hostname || hostname.length > 128 || domain.length > 255 || !isIpv4(ipAddress) || !isIpv4(subnetMask) || !isIpv4(gateway)) {
        return sendError(res, { status: 400, code: 'INVALID_HOST_NETWORK_INPUT', message: '主机名、IP 地址、子网掩码或网关格式不正确' })
      }
      if (!['Asia/Shanghai', 'UTC'].includes(timezone) || !['zh-CN', 'en-US'].includes(locale)) {
        return sendError(res, { status: 400, code: 'UNSUPPORTED_LOCALE_OR_TIMEZONE', message: '时区或语言设置不受支持' })
      }
      const dnsServers = parseStringList(req.body?.dnsServers || [], '域名服务器')
      const internalAddressRanges = parseStringList(req.body?.internalAddressRanges || [], '内部地址列表', 128)
      const ntpServers = parseStringList(req.body?.ntpServers || [], 'NTP 服务器')
      const updatedAt = Date.now()
      db.prepare(`INSERT INTO host_network_config (id, hostname, domain, ip_address, subnet_mask, gateway, dns_servers, internal_address_ranges, timezone, ntp_servers, locale, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET hostname = excluded.hostname, domain = excluded.domain, ip_address = excluded.ip_address,
          subnet_mask = excluded.subnet_mask, gateway = excluded.gateway, dns_servers = excluded.dns_servers,
          internal_address_ranges = excluded.internal_address_ranges, timezone = excluded.timezone,
          ntp_servers = excluded.ntp_servers, locale = excluded.locale, updated_at = excluded.updated_at`)
        .run(hostname, domain, ipAddress, subnetMask, gateway, JSON.stringify(dnsServers), JSON.stringify(internalAddressRanges), timezone, JSON.stringify(ntpServers), locale, updatedAt)
      const row = db.prepare('SELECT * FROM host_network_config WHERE id = 1').get()
      recordAudit(req.user, '保存主机与网络配置', hostname, `IP：${ipAddress}`)
      sendOk(res, { config: publicHostNetworkConfig(row) })
    } catch (error) {
      sendError(res, { status: 400, code: 'HOST_NETWORK_SAVE_FAILED', message: error.message || '保存主机与网络配置失败' })
    }
  })

  return router
}
