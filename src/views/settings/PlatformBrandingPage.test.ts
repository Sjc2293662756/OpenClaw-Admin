import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import { defineComponent } from 'vue'
import PlatformBrandingPage from './PlatformBrandingPage.vue'
import { DEFAULT_PLATFORM_BRANDING } from '@/branding/platform'

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ getToken: () => 'test-token' }),
}))

vi.mock('@/branding/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/branding/platform')>()
  return {
    ...original,
    loadPlatformBranding: vi.fn(async () => ({ ...original.DEFAULT_PLATFORM_BRANDING })),
    savePlatformBranding: vi.fn(),
    resetPlatformBranding: vi.fn(),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ locale: { value: 'zh-CN' } }),
}))

const Host = defineComponent({
  components: { NMessageProvider, PlatformBrandingPage },
  template: '<NMessageProvider><PlatformBrandingPage /></NMessageProvider>',
})

describe('PlatformBrandingPage', () => {
  it('renders the eight canonical fields and both commands', async () => {
    const wrapper = mount(Host)
    await flushPromises()

    const inputs = wrapper.findAll('input')
    expect(inputs).toHaveLength(8)
    expect(inputs.map(input => (input.element as HTMLInputElement).value)).toEqual(
      Object.values(DEFAULT_PLATFORM_BRANDING),
    )
    expect(wrapper.text()).toContain('保存全部名称')
    expect(wrapper.text()).toContain('一键恢复默认名称')
    expect(wrapper.text()).not.toContain('公司与产品的八项统一名称')
  })
})
// @vitest-environment happy-dom
