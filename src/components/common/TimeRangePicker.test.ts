// @vitest-environment happy-dom

import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TimeRangePicker from './TimeRangePicker.vue'
import { rangeForPreset } from '@/utils/time-range'

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: () => ({ warning: vi.fn() }),
  }
})

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  messages: {
    'zh-CN': {
      common: { cancel: '取消', confirm: '确认' },
      pages: {
        dashboard: {
          range: {
            today: '今天',
            last7days: '最近 7 日',
            last30days: '最近 30 日',
            thisMonth: '本月',
            custom: '自定义',
            validation: {
              empty: '空',
              reversed: '反向',
              future: '未来',
            },
          },
        },
      },
    },
  },
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TimeRangePicker', () => {
  it('applies a preset immediately as one complete range', async () => {
    const now = new Date(2026, 6, 28, 15, 30).getTime()
    const wrapper = mount(TimeRangePicker, {
      attachTo: document.body,
      props: {
        modelValue: rangeForPreset('last7days', now),
        preset: 'last7days',
        serverNow: now,
      },
      global: { plugins: [i18n] },
    })

    await wrapper.get('.time-range-trigger').trigger('click')
    await nextTick()
    const today = [...document.querySelectorAll<HTMLButtonElement>('.time-range-option')]
      .find((button) => button.textContent?.trim() === '今天')
    expect(today).toBeTruthy()
    today!.click()
    await nextTick()

    const applied = wrapper.emitted('apply')
    expect(applied).toHaveLength(1)
    expect(applied?.[0]?.[1]).toBe('today')
    const appliedRange = applied?.[0]?.[0] as [number, number]
    expect(appliedRange[0]).toBe(rangeForPreset('today', now)[0])
    expect(appliedRange[1]).toBeGreaterThanOrEqual(now)
    expect(appliedRange[1]).toBeLessThan(now + 1000)
    wrapper.unmount()
  })

  it('keeps the quick jump open for a year choice and closes it after a month choice', async () => {
    const now = new Date(2026, 6, 28, 15, 30).getTime()
    const wrapper = mount(TimeRangePicker, {
      attachTo: document.body,
      props: {
        modelValue: rangeForPreset('last7days', now),
        preset: 'last7days',
        serverNow: now,
      },
      global: { plugins: [i18n] },
    })

    await wrapper.get('.time-range-trigger').trigger('click')
    await nextTick()
    const custom = [...document.querySelectorAll<HTMLButtonElement>('.time-range-option')]
      .find((button) => button.textContent?.trim() === '自定义')
    expect(custom).toBeTruthy()
    custom!.click()
    await nextTick()

    const headers = document.querySelectorAll<HTMLElement>('.n-date-panel-month__text')
    expect(headers.length).toBeGreaterThan(0)
    headers[0]!.click()
    await nextTick()

    const quickPanel = document.querySelector<HTMLElement>('.n-date-panel--month')
    expect(quickPanel).toBeTruthy()
    const columns = quickPanel!.querySelectorAll<HTMLElement>(
      '.n-date-panel-month-calendar__picker-col'
    )
    expect(columns).toHaveLength(2)

    const syntheticYear = document.createElement('div')
    syntheticYear.setAttribute('data-n-date', 'true')
    columns[0]!.appendChild(syntheticYear)
    syntheticYear.click()
    await nextTick()
    expect(document.querySelector('.n-date-panel--month')).toBeTruthy()

    const month = columns[1]!.querySelector<HTMLElement>('[data-n-date]')
    expect(month).toBeTruthy()
    month!.click()
    await nextTick()
    expect(document.querySelector('.n-date-panel--month')).toBeNull()
    expect(document.querySelector('.n-date-panel-calendar')).toBeTruthy()
    wrapper.unmount()
  })
})
