import { describe, expect, it } from 'vitest'
import {
  formatSessionChannelLabel,
  formatSessionConversationTitle,
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

  it('keeps WebChat first-message titles', () => {
    expect(formatSessionConversationTitle({
      key: 'agent:main:main:dm:webchat-123456789012',
      sourceChannel: 'web',
      originKind: 'web',
      sessionTitle: '分析最近三小时告警',
    })).toBe('分析最近三小时告警')
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
