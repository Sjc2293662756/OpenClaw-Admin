import { describe, expect, it } from 'vitest'
import { isLiveChatProcessForSession } from './chat-live-process'

describe('isLiveChatProcessForSession', () => {
  const currentSession = 'agent:main:main:dm:webchat-current'

  it('shows only active process phases for the selected session', () => {
    expect(isLiveChatProcessForSession({ phase: 'thinking', sessionKey: currentSession }, currentSession)).toBe(true)
    expect(isLiveChatProcessForSession({ phase: 'tool', sessionKey: currentSession }, currentSession)).toBe(true)
    expect(isLiveChatProcessForSession({ phase: 'replying', sessionKey: currentSession }, currentSession)).toBe(true)
  })

  it('hides terminal, idle, empty, and other-session status', () => {
    expect(isLiveChatProcessForSession({ phase: 'done', sessionKey: currentSession }, currentSession)).toBe(false)
    expect(isLiveChatProcessForSession({ phase: 'idle', sessionKey: currentSession }, currentSession)).toBe(false)
    expect(isLiveChatProcessForSession({ phase: 'thinking', sessionKey: '' }, currentSession)).toBe(false)
    expect(isLiveChatProcessForSession({ phase: 'thinking', sessionKey: 'agent:main:main:dm:webchat-other' }, currentSession)).toBe(false)
  })
})
