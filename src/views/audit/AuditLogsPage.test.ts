// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AuditLogsPage from './AuditLogsPage.vue'
import { rangeForPreset } from '@/utils/time-range'

vi.mock('naive-ui', async () => {
  const { defineComponent: component, h } = await import('vue')
  const slotComponent = (name: string) => component({ name, setup: (_, { slots }) => () => h('div', slots.default?.()) })
  const buttonComponent = component({ name: 'NButton', emits: ['click'], setup: (_, { emit, slots }) => () => h('button', { onClick: () => emit('click') }, slots.default?.()) })
  const inputComponent = component({
    name: 'NInput', props: { value: { type: String, default: '' } }, emits: ['update:value', 'keyup'],
    setup(props, { emit }) { return () => h('input', { value: props.value, onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value), onKeyup: (event: KeyboardEvent) => emit('keyup', event) }) },
  })
  const selectComponent = component({
    name: 'NSelect', props: { value: { type: [String, Number], default: null }, options: { type: Array, default: () => [] } }, emits: ['update:value'],
    setup(props, { emit }) { return () => h('select', { value: props.value ?? '', onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value) }, [h('option', { value: '' }, '全部'), ...(props.options as Array<{ value: string | number; label: string }>).map((option) => h('option', { value: option.value }, option.label))]) },
  })
  const dataTableComponent = component({
    name: 'NDataTable', props: { data: { type: Array, default: () => [] }, columns: { type: Array, default: () => [] } },
    setup(props) { return () => h('div', { class: 'audit-table-stub' }, (props.data as Array<Record<string, unknown>>).map((row) => { const detailColumn = (props.columns as Array<{ key?: string; render?: (value: Record<string, unknown>) => unknown }>).find((column) => column.key === 'detailEntry'); return h('div', { class: 'audit-row-stub' }, [h('span', String(row.action)), detailColumn?.render?.(row)] as any) })) },
  })
  const drawerComponent = component({ name: 'NDrawer', props: { show: Boolean }, setup: (props, { slots }) => () => props.show ? h('div', { class: 'drawer-stub' }, slots.default?.()) : null })
  const paginationComponent = component({ name: 'NPagination', props: { page: { type: Number, default: 1 } }, emits: ['update:page'], setup: (props, { emit }) => () => h('button', { class: 'next-page', onClick: () => emit('update:page', props.page + 1) }, '下一页') })
  const descriptionsItem = component({ name: 'NDescriptionsItem', props: { label: String }, setup: (props, { slots }) => () => h('div', [h('span', props.label), slots.default?.()]) })
  return {
    NAlert: slotComponent('NAlert'), NButton: buttonComponent, NCard: slotComponent('NCard'), NDataTable: dataTableComponent,
    NDescriptions: slotComponent('NDescriptions'), NDescriptionsItem: descriptionsItem, NDrawer: drawerComponent,
    NDrawerContent: slotComponent('NDrawerContent'), NEmpty: slotComponent('NEmpty'), NIcon: slotComponent('NIcon'),
    NInput: inputComponent, NPagination: paginationComponent, NSelect: selectComponent, NSpace: slotComponent('NSpace'),
    NStatistic: component({ name: 'NStatistic', props: { label: String, value: Number }, template: '<span>{{ label }}:{{ value }}</span>' }),
    NTag: slotComponent('NTag'), NText: slotComponent('NText'), useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
  }
})

vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ getToken: () => 'isolated-test-token' }) }))
vi.mock('@/components/common/TimeRangePicker.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'TimePickerStub', emits: ['apply'], setup: () => () => h('button', { class: 'time-picker-stub' }) }) }
})

function responseFor(url: string, action = '查询结果') {
  const params = new URL(url, 'http://audit.local').searchParams
  const currentPage = Number(params.get('page') || '1')
  const currentPageSize = Number(params.get('pageSize') || '20')
  return new Response(JSON.stringify({
    ok: true,
    logs: [{
      id: `audit-${currentPage}`, actorUserId: 'user-42', username: 'auditor', role: 'auditor', action,
      target: '报告 report-42', detail: '隔离测试说明', createdAt: new Date(2026, 7, 3, 10, 5, 6).getTime(),
      category: 'authorization', result: 'denied', source: 'rpc', restMethod: null, restPath: null,
      rpcMethod: 'config.set', errorCode: 'RPC_METHOD_FORBIDDEN', requestId: 'request-42', sourceAddress: '127.0.0.1',
    }],
    pagination: { page: currentPage, pageSize: currentPageSize, total: 81, totalPages: Math.ceil(81 / currentPageSize) },
    summary: { total: 81, success: 50, failed: 10, denied: 20, unclassified: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function mountPage() { return mount(AuditLogsPage) }

function lastFetchUrl() {
  const calls = vi.mocked(fetch).mock.calls
  return String(calls[calls.length - 1]?.[0])
}

describe('AuditLogsPage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 3, 10, 30, 0))
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(responseFor(String(input)))))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('queries today by default and renders the five server summaries', async () => {
    const wrapper = mountPage()
    await flushPromises()

    const firstUrl = String(vi.mocked(fetch).mock.calls[0]?.[0])
    const today = rangeForPreset('today', new Date(2026, 7, 3, 10, 30, 0).getTime())
    expect(firstUrl).toContain(`from=${today[0]}`)
    expect(firstUrl).toContain(`to=${today[1]}`)
    expect(firstUrl).toContain('page=1')
    expect(firstUrl).toContain('pageSize=20')
    expect(wrapper.text()).toContain('总记录:81')
    expect(wrapper.text()).toContain('成功:50')
    expect(wrapper.text()).toContain('失败:10')
    expect(wrapper.text()).toContain('已记录拒绝:20')
    expect(wrapper.text()).toContain('历史未分类:1')
    wrapper.unmount()
  })

  it('sends filters to the server, resets them, and resets paging when the range or page size changes', async () => {
    const wrapper = mountPage()
    await flushPromises()
    const inputs = wrapper.findAll('input')
    await inputs[0]!.setValue('拒绝记录')
    await inputs[1]!.setValue('auditor')
    await inputs[2]!.setValue('RPC_METHOD_FORBIDDEN')
    const selects = wrapper.findAll('select')
    await selects[0]!.setValue('auditor')
    await selects[1]!.setValue('authorization')
    await selects[2]!.setValue('denied')
    await selects[3]!.setValue('rpc')
    await inputs[0]!.trigger('keyup.enter')
    await flushPromises()

    let requestUrl = lastFetchUrl()
    expect(requestUrl).toContain('keyword=%E6%8B%92%E7%BB%9D%E8%AE%B0%E5%BD%95')
    expect(requestUrl).toContain('username=auditor')
    expect(requestUrl).toContain('role=auditor')
    expect(requestUrl).toContain('category=authorization')
    expect(requestUrl).toContain('result=denied')
    expect(requestUrl).toContain('source=rpc')
    expect(requestUrl).toContain('errorCode=RPC_METHOD_FORBIDDEN')
    expect(requestUrl).toContain('page=1')

    await selects[selects.length - 1]!.setValue('50')
    await flushPromises()
    requestUrl = lastFetchUrl()
    expect(requestUrl).toContain('pageSize=50')
    expect(requestUrl).toContain('page=1')

    await wrapper.get('.next-page').trigger('click')
    await flushPromises()
    requestUrl = lastFetchUrl()
    expect(requestUrl).toContain('page=2')
    expect(requestUrl).toContain('pageSize=50')

    const reset = wrapper.findAll('button').find((button) => button.text() === '重置')
    await reset!.trigger('click')
    await flushPromises()
    requestUrl = lastFetchUrl()
    expect(requestUrl).not.toContain('keyword=')
    expect(requestUrl).not.toContain('username=')
    expect(requestUrl).not.toContain('role=')
    expect(requestUrl).not.toContain('category=')
    expect(requestUrl).not.toContain('result=')
    expect(requestUrl).not.toContain('source=')
    expect(requestUrl).not.toContain('errorCode=')
    expect(requestUrl).toContain('page=1')
    wrapper.unmount()
  })

  it('keeps the newest response when fast consecutive requests complete out of order', async () => {
    const resolvers: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve))))
    const wrapper = mountPage()
    await Promise.resolve()
    const keyword = wrapper.findAll('input')[0]!
    await keyword.setValue('第二次查询')
    await keyword.trigger('keyup.enter')
    expect(resolvers).toHaveLength(2)

    resolvers[1]!(responseFor('/api/audit-logs?page=1&pageSize=20', '最新结果'))
    await flushPromises()
    resolvers[0]!(responseFor('/api/audit-logs?page=1&pageSize=20', '旧结果'))
    await flushPromises()

    expect(wrapper.text()).toContain('最新结果')
    expect(wrapper.text()).not.toContain('旧结果')
    wrapper.unmount()
  })

  it('shows complete safe details and copies the request id', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
    const wrapper = mountPage()
    await flushPromises()
    await wrapper.get('.audit-table-stub button').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('用户 IDuser-42')
    expect(wrapper.text()).toContain('权限校验')
    expect(wrapper.text()).toContain('Gateway RPC')
    expect(wrapper.text()).toContain('RPC_METHOD_FORBIDDEN')
    expect(wrapper.text()).toContain('来源地址127.0.0.1')
    const copyButton = wrapper.findAll('button').find((button) => button.text() === '复制')
    await copyButton!.trigger('click')
    expect(copy).toHaveBeenCalledWith('request-42')
    wrapper.unmount()
  })
})
