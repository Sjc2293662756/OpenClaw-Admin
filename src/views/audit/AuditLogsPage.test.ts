// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AuditLogsPage from './AuditLogsPage.vue'
import { rangeForPreset } from '@/utils/time-range'
import { i18n } from '@/i18n'

const messageApi = { error: vi.fn(), success: vi.fn(), warning: vi.fn() }

vi.mock('naive-ui', async () => {
  const { defineComponent: component, h } = await import('vue')
  const slotComponent = (name: string) => component({ name, setup: (_, { slots }) => () => h('div', slots.default?.()) })
  const buttonComponent = component({ name: 'NButton', props: { disabled: Boolean, loading: Boolean }, emits: ['click'], setup: (props, { emit, slots }) => () => h('button', { disabled: props.disabled, onClick: () => { if (!props.disabled) emit('click') } }, slots.default?.()) })
  const inputComponent = component({
    name: 'NInput', props: { value: { type: [String, Number], default: '' } }, emits: ['update:value', 'keyup'],
    setup(props, { emit }) { return () => h('input', { value: props.value, onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value), onKeyup: (event: KeyboardEvent) => emit('keyup', event) }) },
  })
  const selectComponent = component({
    name: 'NSelect', props: { value: { type: [String, Number], default: null }, options: { type: Array, default: () => [] } }, emits: ['update:value'],
    setup(props, { emit }) { return () => h('select', { value: props.value ?? '', onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value) }, [h('option', { value: '' }, '全部'), ...(props.options as Array<{ value: string | number; label: string }>).map((option) => h('option', { value: option.value }, option.label))]) },
  })
  const dataTableComponent = component({
    name: 'NDataTable', props: { data: { type: Array, default: () => [] }, columns: { type: Array, default: () => [] } },
    setup(props) {
      return () => h('div', { class: 'audit-table-stub' }, (props.data as Array<Record<string, unknown>>).map((row) => {
        const columns = props.columns as Array<{ key?: string; render?: (value: Record<string, unknown>) => unknown }>
        const visible = ['action', 'target', 'source', 'errorCode', 'detailEntry'].map((key) => columns.find((column) => column.key === key)?.render?.(row))
        return h('div', { class: 'audit-row-stub' }, visible as any)
      }))
    },
  })
  const drawerComponent = component({ name: 'NDrawer', props: { show: Boolean }, setup: (props, { slots }) => () => props.show ? h('div', { class: 'drawer-stub' }, slots.default?.()) : null })
  const paginationComponent = component({ name: 'NPagination', props: { page: { type: Number, default: 1 } }, emits: ['update:page'], setup: (props, { emit }) => () => h('button', { class: 'next-page', onClick: () => emit('update:page', props.page + 1) }, '下一页') })
  const descriptionsItem = component({ name: 'NDescriptionsItem', props: { label: String }, setup: (props, { slots }) => () => h('div', [h('span', props.label), slots.default?.()]) })
  const statisticComponent = component({ name: 'NStatistic', props: { value: Number }, setup: (props, { slots }) => () => h('span', [slots.label?.(), ':', String(props.value)]) })
  return {
    NAlert: slotComponent('NAlert'), NButton: buttonComponent, NCard: slotComponent('NCard'), NDataTable: dataTableComponent,
    NDescriptions: slotComponent('NDescriptions'), NDescriptionsItem: descriptionsItem, NDrawer: drawerComponent,
    NDrawerContent: slotComponent('NDrawerContent'), NEmpty: slotComponent('NEmpty'), NIcon: slotComponent('NIcon'),
    NInput: inputComponent, NInputNumber: inputComponent, NPagination: paginationComponent, NSelect: selectComponent, NSpace: slotComponent('NSpace'),
    NStatistic: statisticComponent, NTag: slotComponent('NTag'), NText: slotComponent('NText'), NTooltip: slotComponent('NTooltip'),
    useMessage: () => messageApi,
  }
})

vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ getToken: () => 'isolated-test-token' }) }))
vi.mock('@/components/common/TimeRangePicker.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'TimePickerStub', emits: ['apply'], setup: () => () => h('button', { class: 'time-picker-stub' }) }) }
})

function usersResponse() {
  return new Response(JSON.stringify({ ok: true, users: [
    { id: 'auditor-id', username: 'auditor', role: 'auditor', status: 'active' },
    { id: 'inactive-id', username: 'former-user', role: 'basic', status: 'inactive' },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function responseFor(url: string, action = '查询结果', total = 81, overrides: Record<string, unknown> = {}) {
  const params = new URL(url, 'http://audit.local').searchParams
  const currentPage = Number(params.get('page') || '1')
  const currentPageSize = Number(params.get('pageSize') || '20')
  const maxResults = Number(params.get('maxResults') || '200')
  const browseTotal = Math.min(total, maxResults)
  return new Response(JSON.stringify({
    ok: true,
    logs: [{
      id: `audit-${currentPage}`, actorUserId: 'user-42', username: 'auditor', role: 'auditor', action,
      target: '报告 report-42', detail: '隔离测试说明', createdAt: new Date(2026, 7, 3, 10, 5, 6).getTime(),
      category: 'authorization', result: 'denied', source: 'rpc', restMethod: null, restPath: null,
      rpcMethod: 'config.set', errorCode: 'RPC_METHOD_FORBIDDEN', requestId: 'request-42', sourceAddress: '127.0.0.1',
      ...overrides,
    }],
    pagination: { page: currentPage, pageSize: currentPageSize, total, browseTotal, maxResults, totalPages: Math.ceil(browseTotal / currentPageSize) },
    summary: { total, success: total - 31, failed: 10, denied: 20, unclassified: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function mountPage() { return mount(AuditLogsPage, { global: { plugins: [i18n] } }) }

function lastFetchUrl() {
  const calls = vi.mocked(fetch).mock.calls
  return String(calls[calls.length - 1]?.[0])
}

describe('AuditLogsPage', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh-CN'
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 3, 10, 30, 0))
    messageApi.error.mockReset()
    messageApi.success.mockReset()
    messageApi.warning.mockReset()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      return Promise.resolve(url === '/api/users' ? usersResponse() : responseFor(url))
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('queries today with the default server-side TOP and renders the five summaries', async () => {
    const wrapper = mountPage()
    await flushPromises()

    const firstUrl = String(vi.mocked(fetch).mock.calls[0]?.[0])
    const today = rangeForPreset('today', new Date(2026, 7, 3, 10, 30, 0).getTime())
    expect(firstUrl).toContain(`from=${today[0]}`)
    expect(firstUrl).toContain(`to=${today[1]}`)
    expect(firstUrl).toContain('page=1')
    expect(firstUrl).toContain('pageSize=20')
    expect(firstUrl).toContain('maxResults=200')
    expect(wrapper.text()).toContain('总记录:81')
    expect(wrapper.text()).toContain('成功:50')
    expect(wrapper.text()).toContain('历史未结构化')
    expect(wrapper.text()).toContain('早期审计记录没有结果分类字段，不代表操作失败。')
    expect(wrapper.text()).toContain('system（系统事件）')
    expect(wrapper.text()).toContain('auditor（审计用户，已激活）')
    expect(wrapper.find('.filter-keyword').exists()).toBe(true)
    expect(wrapper.find('.filter-conditions').findAll('select')).toHaveLength(5)
    expect(wrapper.find('.display-controls').findAll('select')).toHaveLength(2)
    wrapper.unmount()
  })

  it('uses the selected system user and all server filters, then resets filters and time to today', async () => {
    const wrapper = mountPage()
    await flushPromises()
    const inputs = wrapper.findAll('input')
    await inputs[0]!.setValue('拒绝记录')
    await inputs[1]!.setValue('RPC_METHOD_FORBIDDEN')
    const selects = wrapper.findAll('select')
    await selects[0]!.setValue('system')
    await selects[1]!.setValue('auditor')
    await selects[2]!.setValue('authorization')
    await selects[3]!.setValue('denied')
    await selects[4]!.setValue('rpc')
    await inputs[0]!.trigger('keyup.enter')
    await flushPromises()

    let requestUrl = lastFetchUrl()
    expect(requestUrl).toContain('username=system')
    expect(requestUrl).toContain('keyword=%E6%8B%92%E7%BB%9D%E8%AE%B0%E5%BD%95')
    expect(requestUrl).toContain('role=auditor')
    expect(requestUrl).toContain('category=authorization')
    expect(requestUrl).toContain('result=denied')
    expect(requestUrl).toContain('source=rpc')
    expect(requestUrl).toContain('errorCode=RPC_METHOD_FORBIDDEN')

    await selects[5]!.setValue('50')
    await flushPromises()
    requestUrl = lastFetchUrl()
    expect(requestUrl).toContain('pageSize=50')
    expect(requestUrl).toContain('page=1')

    await wrapper.get('.next-page').trigger('click')
    await flushPromises()
    expect(lastFetchUrl()).toContain('page=2')

    await selects[6]!.setValue('50')
    await flushPromises()
    requestUrl = lastFetchUrl()
    expect(requestUrl).toContain('maxResults=50')
    expect(requestUrl).toContain('page=1')
    expect(wrapper.text()).toContain('当前筛选结果超过 TOP 50，可提高 TOP 值继续查看。')
    expect(wrapper.text()).toContain('匹配 81 条，当前最多查看 TOP 50。')

    const reset = wrapper.findAll('button').find((button) => button.text() === '重置')
    await reset!.trigger('click')
    await flushPromises()
    requestUrl = lastFetchUrl()
    const today = rangeForPreset('today', new Date(2026, 7, 3, 10, 30, 0).getTime())
    expect(requestUrl).toContain(`from=${today[0]}`)
    expect(requestUrl).not.toContain('username=')
    expect(requestUrl).not.toContain('keyword=')
    expect(requestUrl).not.toContain('role=')
    expect(requestUrl).toContain('page=1')
    expect(requestUrl).toContain('pageSize=50')
    expect(requestUrl).toContain('maxResults=50')
    wrapper.unmount()
  })

  it('bounds custom TOP client input before sending it to the server', async () => {
    const wrapper = mountPage()
    await flushPromises()
    const top = wrapper.findAll('select')[6]!
    await top.setValue('custom')
    const customInput = wrapper.findAll('input')[2]!
    await customInput.setValue('5000')
    const apply = wrapper.findAll('button').find((button) => button.text() === '应用 TOP')
    await apply!.trigger('click')
    await flushPromises()
    expect(lastFetchUrl()).toContain('maxResults=3000')
    wrapper.unmount()
  })

  it('keeps the newest response when fast consecutive requests complete out of order', async () => {
    const resolvers: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/users') return Promise.resolve(usersResponse())
      return new Promise<Response>((resolve) => resolvers.push(resolve))
    }))
    const wrapper = mountPage()
    await Promise.resolve()
    const keyword = wrapper.findAll('input')[0]!
    await keyword.setValue('第二次查询')
    await keyword.trigger('keyup.enter')
    expect(resolvers).toHaveLength(2)

    resolvers[1]!(responseFor('/api/audit-logs?page=1&pageSize=20&maxResults=200', '最新结果'))
    await flushPromises()
    resolvers[0]!(responseFor('/api/audit-logs?page=1&pageSize=20&maxResults=200', '旧结果'))
    await flushPromises()

    expect(wrapper.text()).toContain('最新结果')
    expect(wrapper.text()).not.toContain('旧结果')
    wrapper.unmount()
  })

  it('uses compact dashes in the table while retaining historical missing values in the detail drawer', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      return Promise.resolve(url === '/api/users' ? usersResponse() : responseFor(url, '无说明操作', 1, { target: '', detail: '', source: null, errorCode: null, restMethod: null, restPath: null, rpcMethod: null }))
    }))
    const copy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.find('.audit-table-stub').text()).toContain('无说明操作')
    expect(wrapper.find('.audit-table-stub').text()).toContain('—')
    expect(wrapper.find('.audit-table-stub').text()).not.toContain('历史未记录')
    await wrapper.get('.audit-table-stub button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('完整说明历史未记录')
    expect(wrapper.text()).toContain('REST 方法历史未记录')
    expect(wrapper.text()).toContain('错误码历史未记录')
    const copyButton = wrapper.findAll('button').find((button) => button.text() === '复制')
    await copyButton!.trigger('click')
    expect(copy).toHaveBeenCalledWith('request-42')
    wrapper.unmount()
  })

  it('exports the active server filter and TOP once without changing the current list', async () => {
    let resolveExport: ((response: Response) => void) | null = null
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/users') return Promise.resolve(usersResponse())
      if (url === '/api/audit-logs/export') return new Promise<Response>((resolve) => { resolveExport = resolve })
      return Promise.resolve(responseFor(url, '保留的列表结果', 81))
    }))
    const createObjectUrl = vi.fn(() => 'blob:audit-export')
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    const linkClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const wrapper = mountPage()
    await flushPromises()

    const keyword = wrapper.findAll('input')[0]!
    await keyword.setValue('保留')
    await keyword.trigger('keyup.enter')
    await flushPromises()
    const exportButton = wrapper.findAll('button').find((button) => button.text() === '导出 Excel')!
    await exportButton.trigger('click')
    await exportButton.trigger('click')
    const exportCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/audit-logs/export')
    expect(exportCalls).toHaveLength(1)
    const options = exportCalls[0]![1] as RequestInit
    expect(options.method).toBe('POST')
    expect(options.headers).toMatchObject({ Authorization: 'Bearer isolated-test-token', 'Content-Type': 'application/json' })
    expect(JSON.parse(String(options.body))).toMatchObject({ keyword: '保留', maxResults: 200 })

    resolveExport!(new Response(new Blob(['xlsx']), { status: 200, headers: { 'x-gaiop-export-count': '81' } }))
    await flushPromises()
    expect(createObjectUrl).toHaveBeenCalled()
    expect(linkClick).toHaveBeenCalled()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:audit-export')
    expect(wrapper.text()).toContain('保留的列表结果')
    linkClick.mockRestore()
    wrapper.unmount()
  })

  it('does not send an export request when the current filters have no data', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      return Promise.resolve(url === '/api/users' ? usersResponse() : responseFor(url, '空结果', 0))
    }))
    const wrapper = mountPage()
    await flushPromises()
    const exportButton = wrapper.findAll('button').find((button) => button.text() === '导出 Excel')!
    expect(exportButton.attributes('disabled')).toBeDefined()
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/audit-logs/export')).toBe(false)
    wrapper.unmount()
  })

  it('keeps the current list and reports an export API failure', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/users') return Promise.resolve(usersResponse())
      if (url === '/api/audit-logs/export') return Promise.resolve(new Response(JSON.stringify({ ok: false, error: '导出服务暂不可用' }), { status: 500, headers: { 'content-type': 'application/json' } }))
      return Promise.resolve(responseFor(url, '仍保留的审计列表', 1))
    }))
    const wrapper = mountPage()
    await flushPromises()
    const exportButton = wrapper.findAll('button').find((button) => button.text() === '导出 Excel')!
    await exportButton.trigger('click')
    await flushPromises()
    expect(messageApi.error).toHaveBeenCalledWith('导出服务暂不可用')
    expect(wrapper.text()).toContain('仍保留的审计列表')
    wrapper.unmount()
  })
})
