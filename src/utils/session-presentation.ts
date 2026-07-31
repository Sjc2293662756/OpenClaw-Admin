import type { Session } from '@/api/types'

const CHANNEL_LABELS: Record<string, string> = {
  web: 'GAIOP Web Chat',
  webchat: 'GAIOP Web Chat',
  workspace: 'GAIOP Web Chat',
  feishu: '飞书',
  lark: '飞书',
  'openclaw-lark': '飞书',
  dingtalk: '钉钉',
  'dingtalk-connector': '钉钉',
  wecom: '企业微信',
  'wecom-app': '企业微信',
  'wecom-openclaw-plugin': '企业微信',
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function isLegacyDefaultSession(session: Pick<Session, 'key'>): boolean {
  const key = normalized(session.key).toLowerCase()
  return key === 'main' || key === 'agent:main:main'
}

export function conversationActivityTimestamp(session: Pick<Session, 'lastActivity'>): number {
  const timestamp = Date.parse(normalized(session.lastActivity))
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function compareSessionsByConversationActivity(
  left: Pick<Session, 'key' | 'lastActivity'>,
  right: Pick<Session, 'key' | 'lastActivity'>
): number {
  const activityDifference =
    conversationActivityTimestamp(right) - conversationActivityTimestamp(left)
  if (activityDifference !== 0) return activityDifference
  return normalized(left.key).localeCompare(normalized(right.key))
}

export function isWebConversation(session: Partial<Session> & Pick<Session, 'key'>): boolean {
  return session.originKind === 'web'
    || normalized(session.sourceChannel).toLowerCase() === 'web'
    || session.key.includes(':dm:webchat-')
}

export function sessionSourceChannel(session: Partial<Session> & Pick<Session, 'key'>): string {
  const source = normalized(session.sourceChannel || session.channel).toLowerCase()
  if (source) return source
  const parts = session.key.split(':')
  return normalized(parts[2]).toLowerCase() || 'main'
}

export function formatSessionChannelLabel(session: Partial<Session> & Pick<Session, 'key'>): string {
  if (isLegacyDefaultSession(session)) return '历史默认'
  if (isWebConversation(session)) return 'GAIOP Web Chat'
  const channel = sessionSourceChannel(session)
  return CHANNEL_LABELS[channel] || channel || '未知渠道'
}

function channelUserDisplay(session: Partial<Session> & Pick<Session, 'key'>): string {
  const channel = sessionSourceChannel(session)
  const raw = normalized(
    session.channelUserName
    || session.channelUserId
    || session.ownerUsername
    || session.peer
  )
  if (!raw) return ''
  const prefixes = new Set([
    channel,
    channel === 'wecom' ? 'wecom' : '',
    channel === 'feishu' ? 'feishu' : '',
    channel === 'dingtalk' ? 'dingtalk' : '',
  ].filter(Boolean))
  const separator = raw.indexOf(':')
  if (separator > 0 && prefixes.has(raw.slice(0, separator).toLowerCase())) {
    return raw.slice(separator + 1).trim()
  }
  return raw
}

export function formatSessionConversationTitle(session: Partial<Session> & Pick<Session, 'key'>): string {
  if (isLegacyDefaultSession(session)) return '历史默认会话'
  const savedTitle = normalized(session.sessionTitle)
  if (isWebConversation(session)) return savedTitle || 'GAIOP Web Chat'
  const channel = formatSessionChannelLabel(session)
  const user = channelUserDisplay(session)
  return `${channel}对话${user ? ` · ${user}` : ''}`
}

export function sessionMatchesSearch(
  session: Partial<Session> & Pick<Session, 'key'>,
  query: string
): boolean {
  const search = normalized(query).toLowerCase()
  if (!search) return true
  return [
    formatSessionConversationTitle(session),
    // The internal key remains searchable for diagnostics, but is deliberately
    // not advertised or rendered as a user-facing session name.
    session.key,
    session.agentId,
    session.channel,
    session.peer,
    session.sourceChannel,
    session.channelUserId,
    session.channelUserName,
    session.ownerUsername,
    session.model,
    session.label,
  ].some((value) => normalized(value).toLowerCase().includes(search))
}

export function shouldApplyRealtimeEvent(activeSessionKey: unknown, eventSessionKey: unknown): boolean {
  const active = normalized(activeSessionKey)
  const event = normalized(eventSessionKey)
  return Boolean(active && event && active === event)
}
