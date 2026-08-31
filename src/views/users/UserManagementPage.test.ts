// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, Transition, type Component as VueComponent } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth'
import UserCreatePage from './UserCreatePage.vue'
import UserManagementPage from './UserManagementPage.vue'
import { i18n } from '@/i18n'

describe('user management page routing', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh-CN'
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('leaves the user list transition and renders the create form without a reload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      users: [{
        id: 'initial-admin',
        username: 'admin',
        role: 'admin',
        description: '',
        status: 'active',
        isInitialAdmin: true,
        mustChangePassword: false,
        updatedAt: Date.now(),
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    const pinia = createPinia()
    setActivePinia(pinia)
    const authStore = useAuthStore()
    authStore.token = 'test-token'
    authStore.currentUser = {
      id: 'initial-admin',
      username: 'admin',
      role: 'admin',
      isInitialAdmin: true,
      mustChangePassword: false,
    }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/users', name: 'UserManagement', component: UserManagementPage },
        { path: '/users/create', name: 'UserCreate', component: UserCreatePage },
        { path: '/users/password', name: 'PasswordChange', component: { template: '<div>password</div>' } },
      ],
    })

    const Harness = defineComponent({
      setup() {
        return () => h(NConfigProvider, null, {
          default: () => h(NDialogProvider, null, {
            default: () => h(NMessageProvider, null, {
              default: () => h(RouterView, null, {
                default: ({ Component }: { Component: VueComponent }) => h(Transition, { mode: 'out-in' }, () => h(Component)),
              }),
            }),
          }),
        })
      },
    })

    await router.push('/users')
    await router.isReady()
    const wrapper = mount(Harness, { global: { plugins: [pinia, router, i18n] } })
    await flushPromises()

    await router.push('/users/create')
    await nextTick()
    await flushPromises()

    expect(wrapper.text()).toContain('添加用户')
    expect(wrapper.find('input[placeholder="请输入用户名"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('shows auditors a read-only account list without management actions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      users: [{
        id: 'basic-user',
        username: 'viewer-target',
        role: 'basic',
        description: '只读账户',
        status: 'active',
        isInitialAdmin: false,
        updatedAt: Date.now(),
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    const pinia = createPinia()
    setActivePinia(pinia)
    const authStore = useAuthStore()
    authStore.token = 'auditor-token'
    authStore.currentUser = {
      id: 'auditor-id',
      username: 'auditor',
      role: 'auditor',
      isInitialAdmin: false,
      mustChangePassword: false,
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/users', name: 'UserManagement', component: UserManagementPage },
        { path: '/users/password', name: 'PasswordChange', component: { template: '<div>password</div>' } },
      ],
    })
    await router.push('/users')
    await router.isReady()
    const Harness = defineComponent({
      setup() {
        return () => h(NConfigProvider, null, {
          default: () => h(NDialogProvider, null, {
            default: () => h(NMessageProvider, null, {
              default: () => h(RouterView),
            }),
          }),
        })
      },
    })
    const wrapper = mount(Harness, { global: { plugins: [pinia, router, i18n] } })
    await flushPromises()

    expect(wrapper.text()).toContain('当前为审计用户，仅可查看账户信息')
    expect(wrapper.text()).toContain('viewer-target')
    const buttonText = wrapper.findAll('button').map(button => button.text()).join('|')
    expect(buttonText).not.toContain('添加用户')
    expect(buttonText).not.toContain('编辑')
    expect(buttonText).not.toContain('重置')
    expect(buttonText).not.toContain('删除')
    wrapper.unmount()
  })

  it('opens the permission drawer, hides internal modules and switches target users in place', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const permissionTarget = url.includes('/users/initial-admin/')
        ? { id: 'initial-admin', username: 'admin', role: 'admin', moduleKey: 'dashboard', moduleName: '仪表盘', group: '业务管理', isInitialAdmin: true }
        : url.includes('/users/auditor-user/')
          ? { id: 'auditor-user', username: 'audit-target', role: 'auditor', moduleKey: 'audit', moduleName: '审计信息', group: '高级管理', isInitialAdmin: false }
          : { id: 'basic-user', username: 'viewer-target', role: 'basic', moduleKey: 'alerts.records', moduleName: '告警记录', group: '业务管理', isInitialAdmin: false }
      const moduleRow = (moduleKey: string, name: string, group: string, locked = false) => ({
        moduleKey,
        name,
        group,
        risk: moduleKey === 'platformBranding' ? 'high' : 'medium',
        dependencies: [],
        dataScope: moduleKey === 'alerts.records' ? '系统级脱敏告警记录；包含当前页导出' : '全量只读安全投影',
        defaultAllowed: true,
        override: null,
        effectiveAllowed: true,
        locked,
        lockReason: locked ? '仅初始管理员可使用' : null,
      })
      const body = url.includes('/module-permissions') ? {
        ok: true,
        user: { id: permissionTarget.id, username: permissionTarget.username, role: permissionTarget.role, status: 'active', isInitialAdmin: permissionTarget.isInitialAdmin },
        permissionVersion: 0,
        modules: [
          moduleRow('data.allUsers', '查看所有用户数据', '数据范围'),
          moduleRow(permissionTarget.moduleKey, permissionTarget.moduleName, permissionTarget.group),
          moduleRow('alerts.export', '告警导出', '业务管理'),
          moduleRow('users', '账户列表', '高级管理'),
          moduleRow('userAdministration', '账户管理', '高级管理'),
          moduleRow('platformBranding', '平台品牌配置', '高级管理', true),
        ],
      } : {
        ok: true,
        users: [
          {
              id: 'basic-user',
              username: 'viewer-target',
              role: 'basic',
              description: '基础用户',
              status: 'active',
              isInitialAdmin: false,
              updatedAt: Date.now(),
          },
          {
            id: 'auditor-user',
            username: 'audit-target',
            role: 'auditor',
            description: '审计用户',
            status: 'active',
            isInitialAdmin: false,
            updatedAt: Date.now(),
          },
          {
            id: 'initial-admin',
            username: 'admin',
            role: 'admin',
            description: '初始管理员',
            status: 'active',
            isInitialAdmin: true,
            updatedAt: Date.now(),
          },
        ],
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const pinia = createPinia()
    setActivePinia(pinia)
    const authStore = useAuthStore()
    authStore.token = 'initial-token'
    authStore.currentUser = {
      id: 'initial-admin',
      username: 'admin',
      role: 'admin',
      isInitialAdmin: true,
      mustChangePassword: false,
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/users', name: 'UserManagement', component: UserManagementPage },
        { path: '/users/create', name: 'UserCreate', component: UserCreatePage },
        { path: '/users/:id/edit', name: 'UserEdit', component: { template: '<div>edit</div>' } },
        { path: '/users/password', name: 'PasswordChange', component: { template: '<div>password</div>' } },
      ],
    })
    await router.push('/users')
    await router.isReady()
    const Harness = defineComponent({
      setup() {
        return () => h(NConfigProvider, null, {
          default: () => h(NDialogProvider, null, {
            default: () => h(NMessageProvider, null, {
              default: () => h(RouterView),
            }),
          }),
        })
      },
    })
    const wrapper = mount(Harness, { attachTo: document.body, global: { plugins: [pinia, router, i18n] } })
    await flushPromises()

    const permissionButton = wrapper.findAll('button').find(button => button.text().trim() === '权限')
    expect(permissionButton).toBeTruthy()
    await permissionButton!.trigger('click')
    await nextTick()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/users/basic-user/module-permissions', expect.any(Object))
    expect(document.body.textContent).toContain('模块权限配置')
    expect(document.body.textContent).toContain('告警记录')
    expect(document.body.textContent).toContain('数据范围')
    expect(document.body.textContent).toContain('查看所有用户数据')
    expect(document.body.textContent).toContain('角色默认')
    expect(document.body.textContent).toContain('恢复默认')
    expect(document.body.textContent).toContain('尚无个人调整')
    expect(document.body.textContent).not.toContain('最终结果')
    expect(document.body.textContent).not.toContain('告警导出')
    expect(document.body.textContent).not.toContain('账户列表')
    expect(document.body.textContent).not.toContain('账户管理')
    expect(document.body.textContent).not.toContain('平台品牌配置')

    const dataScopeRow = [...document.body.querySelectorAll<HTMLElement>('.permission-row')]
      .find(row => row.textContent?.includes('查看所有用户数据'))
    expect(dataScopeRow).toBeTruthy()
    expect([...dataScopeRow!.querySelectorAll<HTMLButtonElement>('button')]
      .map(button => button.textContent?.trim())).toEqual(['角色默认', '允许', '拒绝', '恢复默认'])
    expect([...dataScopeRow!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '恢复默认')?.disabled).toBe(true)

    const alertRow = [...document.body.querySelectorAll<HTMLElement>('.permission-row')]
      .find(row => row.textContent?.includes('告警记录'))
    expect(alertRow).toBeTruthy()
    const denyButton = [...alertRow!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '拒绝')
    denyButton!.click()
    await nextTick()

    const saveButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '保存权限')
    saveButton!.click()
    await nextTick()
    const confirmButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '确认保存')
    confirmButton!.click()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/users/basic-user/module-permissions', expect.objectContaining({ method: 'PUT' }))
    expect(document.body.textContent).not.toContain('告警导出')
    expect(document.body.textContent).not.toContain('账户列表')
    expect(document.body.textContent).not.toContain('账户管理')
    expect(document.body.textContent).not.toContain('平台品牌配置')

    const userSelect = wrapper.findAllComponents(NSelect)
      .find((component) => component.attributes('data-testid') === 'permission-user-select')
    expect(userSelect).toBeTruthy()
    userSelect!.vm.$emit('update:value', 'auditor-user')
    await nextTick()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/users/auditor-user/module-permissions', expect.any(Object))
    expect(document.body.textContent).toContain('audit-target')
    expect(document.body.textContent).toContain('审计信息')

    const refreshedUserSelect = wrapper.findAllComponents(NSelect)
      .find((component) => component.attributes('data-testid') === 'permission-user-select')
    refreshedUserSelect!.vm.$emit('update:value', 'initial-admin')
    await nextTick()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/users/initial-admin/module-permissions', expect.any(Object))
    expect(document.body.textContent).toContain('初始管理员权限固定允许，仅供查看')
    const initialSaveButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '保存权限')
    expect(initialSaveButton?.disabled).toBe(true)
    const initialRestoreAllButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '全部恢复默认')
    expect(initialRestoreAllButton?.disabled).toBe(true)
    const permissionChoices = [...document.body.querySelectorAll('button')]
      .filter(button => ['角色默认', '允许', '拒绝'].includes(button.textContent?.trim() || ''))
    expect(permissionChoices.length).toBeGreaterThan(0)
    expect(permissionChoices.every(button => button.hasAttribute('disabled'))).toBe(true)
    wrapper.unmount()
  })
})
