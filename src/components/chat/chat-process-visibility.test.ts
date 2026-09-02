import { describe, expect, it } from 'vitest'
import chatPageSource from '@/views/chat/ChatPage.vue?raw'
import agentChatPanelSource from '@/components/office/AgentChatPanel.vue?raw'
import hermesClientSource from '@/api/hermes/client.ts?raw'

const visibilityGuard = 'v-if="chatDisplayPreferences.preferences.showThinkingProcess" class="chat-compose-status-line"'
const detailsGuard = 'v-if="chatDisplayPreferences.preferences.showThinkingProcess && showAgentDetails && hasAgentDetails"'

describe('chat process visibility integration', () => {
  it('controls the WebChat status and details without controlling report cards or stop actions', () => {
    expect(chatPageSource).toContain(visibilityGuard)
    expect(chatPageSource).toContain(detailsGuard)
    expect(chatPageSource).toContain('<ReportAttachmentList')
    expect(chatPageSource).toContain('v-if="agentBusy"')
    expect(chatPageSource).toContain(':component="StopCircleOutline"')
  })

  it('controls both normal and expanded Office chat status regions without removing results or stop actions', () => {
    expect(agentChatPanelSource.split(visibilityGuard)).toHaveLength(3)
    expect(agentChatPanelSource.split(detailsGuard)).toHaveLength(3)
    expect(agentChatPanelSource.split('<ReportAttachmentList')).toHaveLength(3)
    expect(agentChatPanelSource.split('v-if="agentBusy"')).toHaveLength(3)
  })

  it('keeps the Hermes response transport permanently streaming', () => {
    expect(hermesClientSource).toContain('stream: true')
    expect(hermesClientSource).not.toContain('showThinkingProcess')
  })
})
