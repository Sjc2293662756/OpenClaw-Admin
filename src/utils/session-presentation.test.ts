import { describe, expect, it } from 'vitest'
import {
  compareSessionsByConversationActivity,
  formatSessionChannelLabel,
  formatSessionConversationTitle,
  isLegacyDefaultSession,
  sessionMatchesSearch,
  shouldApplyRealtimeEvent,
} from './session-presentation'

describe('session presentation boundaries', () => {
  it('uses stable channel and user names without pretending external sessions are WebChat', () => {
    expect(formatSessionConversationTitle({
      key: 'agent:main:wecom:direct:yangs',
      channel: 'wecom',
      sourceChannel: 'wecom',
      originKind: 'channel',
      channelUserName: 'yangs',
    })).toBe('企业微信对话 · yangs')
    expect(formatSessionConversationTitle({
      key: 'agent:main:feishu:dm:ou_123',
      sourceChannel: 'feishu',
      originKind: 'channel',
      channelUserId: 'ou_123',
    })).toBe('飞书对话 · ou_123')
    expect(formatSessionChannelLabel({ key: 'agent:main:main', channel: 'main' })).toBe('历史默认')
    expect(formatSessionConversationTitle({ key: 'agent:main:main', channel: 'main' })).toBe('历史默认会话')
  })

  it('labels personal WeChat sessions as 个人微信 with the GAIOP account name', () => {
    const key = 'agent:main:openclaw-weixin:9150aa2b4764-im-bot:direct:o9cq809tqf_xx4jktqcs8859ks5e@im.wechat'
    expect(formatSessionChannelLabel({ key, channel: 'openclaw-weixin', sourceChannel: 'openclaw-weixin' })).toBe('个人微信')
    expect(formatSessionConversationTitle({
      key,
      channel: 'openclaw-weixin',
      sourceChannel: 'openclaw-weixin',
      channelUserName: '杨硕微信',
    })).toBe('个人微信对话 · 杨硕微信')
  })

  it('keeps WebChat first-message titles', () => {
    const session = {
      key: 'agent:main:main:dm:webchat-123456789012',
      sourceChannel: 'web',
      originKind: 'web',
      sessionTitle: '分析最近三小时告警',
    } as const
    expect(formatSessionConversationTitle(session)).toBe('分析最近三小时告警')
    expect(sessionMatchesSearch(session, '三小时告警')).toBe(true)
    expect(sessionMatchesSearch(session, 'webchat-123456')).toBe(true)
    expect(sessionMatchesSearch(session, '不存在的名称')).toBe(false)
  })

  it('recognizes both Gateway default-key forms and keeps missing activity at the bottom', () => {
    expect(isLegacyDefaultSession({ key: 'main' })).toBe(true)
    expect(isLegacyDefaultSession({ key: 'agent:main:main' })).toBe(true)
    expect(isLegacyDefaultSession({ key: 'agent:main:main:dm:webchat-123456789012' })).toBe(false)

    const sessions = [
      { key: 'agent:main:main', lastActivity: '' },
      { key: 'older', lastActivity: '2026-07-01T00:00:00.000Z' },
      { key: 'newer', lastActivity: '2026-07-29T00:00:00.000Z' },
    ].sort(compareSessionsByConversationActivity)

    expect(sessions.map((session) => session.key)).toEqual([
      'newer',
      'older',
      'agent:main:main',
    ])
  })

  it('applies realtime content only to the exact selected session key', () => {
    expect(shouldApplyRealtimeEvent(
      'agent:main:wecom:direct:yangs',
      'agent:main:wecom:direct:yangs'
    )).toBe(true)
    expect(shouldApplyRealtimeEvent(
      'agent:main:main',
      'agent:main:wecom:direct:yangs'
    )).toBe(false)
    expect(shouldApplyRealtimeEvent('', 'agent:main:wecom:direct:yangs')).toBe(false)
    expect(shouldApplyRealtimeEvent('agent:main:main', '')).toBe(false)
  })
})
