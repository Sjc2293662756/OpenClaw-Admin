// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config, flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import Dashboard from './Dashboard.vue'

const mocks = vi.hoisted(() => {
  const rpc = {
    getUsageCost: vi.fn(),
  }
  const websocket = {
    state: 'disconnected',
    rpc,
    subscribe: vi.fn(),
  }
  return {
    rpc,
    websocket,
    stateChangeHandler: null as null | (() => void),
  }
})

vi.mock('@/stores/websocket', () => ({
  useWebSocketStore: () => mocks.websocket,
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ getToken: () => 'test-token' }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('vue-i18n', async () => {
  const { ref } = await vi.importActual<typeof import('vue')>('vue')
  return {
    useI18n: () => ({
      t: (key: string) => key,
      locale: ref('zh-CN'),
    }),
  }
})

function usagePayload() {
  return {
    updatedAt: Date.now(),
    startDate: '2026-07-25',
    endDate: '2026-07-31',
    sessions: [],
    totals: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    },
    aggregates: {
      messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byModel: [],
      byProvider: [],
      byAgent: [],
      byChannel: [],
      daily: [{ date: '2026-07-31', tokens: 1, cost: 0, messages: 1, toolCalls: 0, errors: 0 }],
    },
  }
}

describe('dashboard initial loading', () => {
  beforeEach(() => {
    config.global.renderStubDefaultSlot = true
    mocks.websocket.state = 'disconnected'
    mocks.stateChangeHandler = null
    mocks.websocket.subscribe.mockReset()
    mocks.websocket.subscribe.mockImplementation((_event, handler) => {
      mocks.stateChangeHandler = handler
      return () => {}
    })
    Object.values(mocks.rpc).forEach((mock) => mock.mockReset())
    mocks.rpc.getUsageCost.mockResolvedValue(null)

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/health') {
        return new Response('', {
          status: 200,
          headers: { date: 'Fri, 31 Jul 2026 00:00:00 GMT' },
        })
      }
      if (url.startsWith('/api/dashboard/usage?')) {
        return new Response(JSON.stringify({ ok: true, usage: usagePayload(), cache: 'miss' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === '/api/dashboard/summary') {
        return new Response(JSON.stringify({
          ok: true,
          summary: { sessionCount: 0, cronCount: 0, modelCount: 0, installedSkills: 0 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
  })

  afterEach(() => {
    config.global.renderStubDefaultSlot = false
    vi.unstubAllGlobals()
  })

  it('waits for the first Gateway connection and loads usage exactly once', async () => {
    const wrapper = shallowMount(Dashboard, {
      global: {
        stubs: {
          TimeRangePicker: {
            name: 'TimeRangePicker',
            template: '<button class="time-range-picker-stub" />',
            emits: ['apply'],
          },
        },
      },
    })
    await flushPromises()

    const fetchMock = vi.mocked(fetch)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/dashboard/usage?'))).toHaveLength(0)

    mocks.websocket.state = 'connected'
    mocks.stateChangeHandler?.()
    await flushPromises()

    const usageCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/dashboard/usage?'))
    expect(usageCalls).toHaveLength(1)
    expect(String(usageCalls[0]?.[0])).toContain('startDate=2026-07-31')
    expect(String(usageCalls[0]?.[0])).toContain('endDate=2026-07-31')
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/dashboard/summary')).toHaveLength(1)

    mocks.stateChangeHandler?.()
    await flushPromises()
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/dashboard/usage?'))).toHaveLength(1)
    wrapper.unmount()
  })

  it('uses a manually applied range for later queries in the current dashboard instance', async () => {
    mocks.websocket.state = 'connected'
    const wrapper = shallowMount(Dashboard, {
      global: {
        stubs: {
          TimeRangePicker: {
            name: 'TimeRangePicker',
            template: '<button class="time-range-picker-stub" />',
            emits: ['apply'],
          },
        },
      },
    })
    await flushPromises()

    const manualRange: [number, number] = [
      new Date(2026, 6, 2, 0, 0, 0, 0).getTime(),
      new Date(2026, 6, 31, 0, 0, 0, 0).getTime(),
    ]
    const picker = wrapper.findComponent('.time-range-picker-stub') as VueWrapper
    picker.vm.$emit('apply', manualRange, 'last30days')
    await flushPromises()

    const usageCalls = vi.mocked(fetch).mock.calls
      .filter(([url]) => String(url).startsWith('/api/dashboard/usage?'))
    expect(usageCalls).toHaveLength(2)
    expect(String(usageCalls[1]?.[0])).toContain('startDate=2026-07-02')
    expect(String(usageCalls[1]?.[0])).toContain('endDate=2026-07-31')
    wrapper.unmount()
  })

})
