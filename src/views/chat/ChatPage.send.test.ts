// @vitest-environment happy-dom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { NMessageProvider } from 'naive-ui'
import { h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPage from './ChatPage.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'

const websocket = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  rpc: {
    getConfig: vi.fn(async () => ({})),
    listSkills: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    getSessionsUsage: vi.fn(async () => ({ sessions: [] })),
    listChatHistory: vi.fn(async () => []),
  },
}))

vi.mock('@/stores/websocket', () => ({ useWebSocketStore: () => websocket }))
vi.mock('@/composables/useEdgeTTS', async () => {
  const { ref } = await import('vue')
  return { useEdgeTTS: () => ({ speak: vi.fn(), stop: vi.fn(), isPlaying: ref(false), isLoading: ref(false) }) }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const sessionKey = 'agent:main:main:dm:webchat-00000000000000000000000000000001'
const created = { sessionKey, runStarted: true, idempotencyKey: 'test-first-send', runId: 'test-run' }
let wrapper: VueWrapper | undefined

async function renderPage(workspace = true) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().currentUser = { id: 'test-user', username: 'test-user', role: 'admin' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/workspace', name: 'ChatWorkspace', component: { template: '<div />' } }],
  })
  await router.push('/workspace')
  const chat = useChatStore()
  const history = vi.spyOn(chat, 'fetchHistory').mockResolvedValue()
  const sessions = useSessionStore()
  wrapper = mount({ render: () => h(NMessageProvider, null, { default: () => h(ChatPage, { workspace }) }) }, {
    global: {
      plugins: [pinia, router, createI18n({
        legacy: false, locale: 'zh-CN', missingWarn: false, fallbackWarn: false,
        messages: { 'zh-CN': { pages: { chat: { actions: { send: '发送' } } } } },
      })],
    },
  })
  await flushPromises()
  const input = wrapper.find('textarea')
  const sendButtons = () => wrapper!.findAll('button').filter(button => button.text().trim() === '发送')
  return { chat, sessions, router, history, input, sendButtons }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, reports: [] }))))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ChatPage send submission guard', () => {
  it('accepts one first send across delayed creation, navigation and history loading', async () => {
    const page = await renderPage()
    const creation = deferred<typeof created>()
    const navigation = deferred<void>()
    const history = deferred<void>()
    const create = vi.spyOn(page.sessions, 'createWorkspaceConversation').mockReturnValue(creation.promise)
    vi.spyOn(page.router, 'replace').mockImplementation(() => navigation.promise)
    page.history.mockImplementation(key => key ? history.promise : Promise.resolve())
    const adopt = vi.spyOn(page.chat, 'adoptCreatedSessionMessage')

    await page.input.setValue('生成一份测试报告')
    await page.input.trigger('keydown', { key: 'Enter' })
    for (let index = 0; index < 30; index++) await page.input.trigger('keydown', { key: 'Enter' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(page.sendButtons()[0]!.element.hasAttribute('disabled')).toBe(true)

    creation.resolve(created)
    await flushPromises()
    await page.input.trigger('keydown', { key: 'Enter' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(adopt).not.toHaveBeenCalled()

    navigation.resolve()
    await flushPromises()
    expect(adopt).toHaveBeenCalledTimes(1)
    expect(page.sendButtons()[0]!.element.hasAttribute('disabled')).toBe(true)
    history.resolve()
    await flushPromises()
    expect(page.input.element.value).toBe('')
    expect(page.chat.messages.filter(item => item.role === 'user')).toHaveLength(1)

    page.chat.getOrCreateAgentStatus('main').phase = 'done'
    const send = vi.spyOn(page.chat, 'sendMessage').mockResolvedValue()
    await page.input.setValue('继续测试正常会话')
    await page.input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('releases the local guard after a creation error and keeps the draft available', async () => {
    const page = await renderPage()
    const create = vi.spyOn(page.sessions, 'createWorkspaceConversation').mockRejectedValueOnce(new Error('test failure'))
    await page.input.setValue('保留本次输入')
    await page.sendButtons()[0]!.trigger('click')
    await flushPromises()
    expect(page.input.element.value).toBe('保留本次输入')
    expect(page.sendButtons()[0]!.element.hasAttribute('disabled')).toBe(false)
    create.mockReturnValue(new Promise(() => {}))
    await page.sendButtons()[0]!.trigger('click')
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('ignores auto-repeat Enter and preserves Shift+Enter without submitting', async () => {
    const page = await renderPage()
    const create = vi.spyOn(page.sessions, 'createWorkspaceConversation').mockReturnValue(new Promise(() => {}))
    await page.input.setValue('测试键盘发送')
    await page.input.trigger('keydown', { key: 'Enter', repeat: true })
    await page.input.trigger('keydown', { key: 'Enter', ctrlKey: true, repeat: true })
    await page.input.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(create).not.toHaveBeenCalled()
    await page.input.trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('disables quick reply sends during an existing conversation submission', async () => {
    localStorage.setItem('openclaw_chat_quick_replies_v1', JSON.stringify([
      { id: 'quick-test', title: '测试快捷问题', content: '快捷问题内容', updatedAt: 1 },
    ]))
    const page = await renderPage(false)
    const pending = deferred<void>()
    const send = vi.spyOn(page.chat, 'sendMessage').mockReturnValue(pending.promise)
    await page.input.setValue('当前正在发送的问题')
    await page.input.trigger('keydown', { key: 'Enter' })
    expect(page.sendButtons()).toHaveLength(2)
    expect(page.sendButtons().every(button => button.element.hasAttribute('disabled'))).toBe(true)
    await page.sendButtons()[0]!.trigger('click')
    await page.input.trigger('keydown', { key: 'Enter' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(page.input.element.value).toBe('当前正在发送的问题')
    pending.resolve()
    await flushPromises()
  })
})
