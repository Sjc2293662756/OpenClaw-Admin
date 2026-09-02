// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChatDisplayPreferencesPanel from './ChatDisplayPreferencesPanel.vue'
import { useChatDisplayPreferencesStore } from '@/stores/chat-display-preferences'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ locale: { value: 'zh-CN' } }) }))

vi.mock('naive-ui', () => ({
  NAlert: { template: '<div><slot /><slot name="action" /></div>' },
  NButton: { inheritAttrs: false, template: '<button v-bind="$attrs"><slot /></button>' },
  NSwitch: {
    props: ['value', 'disabled', 'loading'],
    emits: ['update:value'],
    template: '<button class="preference-switch" :disabled="disabled" @click="$emit(\'update:value\', !value)">{{ value ? \'on\' : \'off\' }}</button>',
  },
  NText: { template: '<span><slot /></span>' },
}))

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  setActivePinia(createPinia())
  vi.restoreAllMocks()
})

describe('ChatDisplayPreferencesPanel', () => {
  it('shows the user-facing name and retries a failed account preference read', async () => {
    const store = useChatDisplayPreferencesStore()
    store.activate({ id: 'user-one' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('temporary failure')))
    const wrapper = mount(ChatDisplayPreferencesPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('显示思考过程')
    expect(wrapper.text()).toContain('流式输出始终开启')
    expect(wrapper.text()).toContain('暂时无法读取已保存设置')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      preferences: { showThinkingProcess: false, updatedAt: 20 },
    }))))
    await wrapper.findAll('button').find((button) => button.text() === '重试')!.trigger('click')
    await flushPromises()
    expect(store.preferences.showThinkingProcess).toBe(false)
    expect(wrapper.find('.preference-switch').text()).toBe('off')
    wrapper.unmount()
  })

  it('keeps the last saved value after failure and changes it only after a successful save', async () => {
    const store = useChatDisplayPreferencesStore()
    store.activate({ id: 'user-one' })
    store.preferencesReady = true
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('save failed')))
    const wrapper = mount(ChatDisplayPreferencesPanel)
    await wrapper.find('.preference-switch').trigger('click')
    await flushPromises()
    expect(store.preferences.showThinkingProcess).toBe(true)
    expect(wrapper.text()).toContain('仍保留上一次已保存的选择')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      preferences: { showThinkingProcess: false, updatedAt: 30 },
    }))))
    await wrapper.find('.preference-switch').trigger('click')
    await flushPromises()
    expect(store.preferences.showThinkingProcess).toBe(false)
    wrapper.unmount()
  })
})
