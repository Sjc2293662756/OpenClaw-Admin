// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AlertNotificationPreferencesPanel from './AlertNotificationPreferencesPanel.vue'

const mocked = vi.hoisted(() => ({
  loadPreferences: vi.fn().mockResolvedValue(false),
  retryPreferences: vi.fn().mockResolvedValue(true),
  savePreferences: vi.fn(),
}))

vi.mock('@/stores/alert-realtime', () => ({
  DEFAULT_ALERT_NOTIFICATION_PREFERENCES: {
    realtimeEnabled: true, soundEnabled: true,
    minorPopupEnabled: true, minorNotificationEnabled: true,
    majorPopupEnabled: true, majorNotificationEnabled: true,
    criticalPopupEnabled: true, criticalNotificationEnabled: true,
  },
  useAlertRealtimeStore: () => ({
    preferences: {
      realtimeEnabled: true, soundEnabled: true,
      minorPopupEnabled: true, minorNotificationEnabled: true,
      majorPopupEnabled: true, majorNotificationEnabled: true,
      criticalPopupEnabled: true, criticalNotificationEnabled: true,
    },
    preferencesReady: false,
    preferencesLoading: false,
    preferencesLoadError: 'ALERT_NOTIFICATION_PREFERENCES_UNAVAILABLE',
    preferencesSaving: false,
    preferencesSaveError: null,
    ...mocked,
  }),
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ locale: { value: 'zh-CN' } }) }))

vi.mock('naive-ui', () => ({
  NAlert: { template: '<div><slot /><slot name="action" /></div>' },
  NButton: { inheritAttrs: false, template: '<button v-bind="$attrs"><slot /></button>' },
  NButtonGroup: { template: '<div><slot /></div>' },
  NSwitch: { template: '<input type="checkbox" />' },
  NText: { template: '<span><slot /></span>' },
}))

afterEach(() => vi.clearAllMocks())

describe('AlertNotificationPreferencesPanel', () => {
  it('offers an explicit in-panel retry after a preference-read failure', async () => {
    const wrapper = mount(AlertNotificationPreferencesPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('按全部开启的安全默认值')
    expect(wrapper.text()).toContain('在此重试')
    expect(wrapper.text()).not.toContain('系统设置')
    const retry = wrapper.findAll('button').find((button) => button.text() === '重试')
    expect(retry).toBeTruthy()
    await retry!.trigger('click')
    await flushPromises()
    expect(mocked.retryPreferences).toHaveBeenCalledOnce()
    wrapper.unmount()
  })
})
